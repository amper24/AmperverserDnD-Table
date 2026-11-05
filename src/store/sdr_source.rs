//! Источник данных SDR (базовый справочник): Git-репозиторий, локальная папка или встроенный (fallback).
//! Данные НЕ вшиты в бинарник — загружаются извне при старте.
//! Использует git CLI (std::process::Command), чтобы не добавлять зависимости git2 (crates.io недоступен локально).
//!
//! Из Git в кэш попадает только папка [`SDR_DIR`] (sparse-checkout): исходники проекта не клонируются.
//! Забрать данные из Git можно один раз (`sdr.update: once`, по умолчанию) — обновление в этом режиме
//! делает кнопка на странице root (`POST /api/admin/sdr`), а не каждый запуск.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Папка репозитория с данными справочника — единственное, что нужно от Git.
pub const SDR_DIR: &str = "data_seed";

/// Когда обновлять кэш Git.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SdrUpdate {
    /// Только если кэша ещё нет: сеть нужна один раз за всё время жизни установки.
    Once,
    /// Дотягивать свежие данные при каждом запуске (`sdr.update: always`).
    Always,
}

/// Абстракция над источником файлов SDR.
pub trait SdrSource: Send + Sync {
    /// Список всех файлов в источнике (относительные пути).
    fn list_files(&self) -> Result<Vec<String>>;
    /// Прочитать файл по относительному пути.
    fn read_file(&self, path: &str) -> Result<Vec<u8>>;
    /// Явно обновить источник (для Git — `git pull`). Источники без сети ничего не делают.
    fn refresh(&self) -> Result<()> {
        Ok(())
    }
}

/// Источник: Git-репозиторий. В локальный кэш клонируется только `data_seed/` (sparse-checkout,
/// без остальных файлов проекта), повторно за процесс — не более одного сетевого вызова.
pub struct GitSdrSource {
    url: String,
    branch: String,
    clone_dir: PathBuf,
    update: SdrUpdate,
    /// Итог клонирования/обновления в этом процессе: `None` — ещё не готовили.
    /// `read_file` вызывается на каждый файл, и сетевой вызов на файл недопустим.
    ready: std::sync::Mutex<Option<Result<(), String>>>,
}

impl GitSdrSource {
    pub fn new(url: &str, branch: &str, clone_dir: &Path, update: SdrUpdate) -> Self {
        Self {
            url: url.to_string(),
            branch: branch.to_string(),
            clone_dir: clone_dir.to_path_buf(),
            update,
            ready: std::sync::Mutex::new(None),
        }
    }

    /// Убедиться, что данные есть локально. Клон/`git pull` выполняется один раз за процесс.
    fn ensure_cloned(&self) -> Result<()> {
        let mut ready = self.ready.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(done) = ready.as_ref() {
            return done.clone().map_err(|e| anyhow::anyhow!("{e}"));
        }
        let result = self.prepare();
        *ready = Some(match &result {
            Ok(()) => Ok(()),
            Err(e) => Err(format!("{e:#}")),
        });
        result
    }

    /// Подготовить кэш данных: клон (если нужно) и, в режиме `Always`, обновление.
    fn prepare(&self) -> Result<()> {
        if self.clone_dir.join(".git").exists() {
            // Прежние сборки клонировали весь репозиторий — сужаем кэш до данных.
            self.narrow_cache();
            if self.update == SdrUpdate::Always {
                self.pull();
            }
            if self.clone_dir.join(SDR_DIR).is_dir() {
                return Ok(());
            }
            tracing::warn!(
                "в кэше SDR нет папки {SDR_DIR} ({}) — клонирую заново",
                self.clone_dir.display()
            );
            let _ = std::fs::remove_dir_all(&self.clone_dir);
        }
        if let Some(parent) = self.clone_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Сначала просим у Git только data_seed (без блобов остальных файлов).
        if let Err(e) = self.clone_data() {
            tracing::warn!("не удалось забрать только {SDR_DIR} ({e:#}) — пробую полный клон");
            let _ = std::fs::remove_dir_all(&self.clone_dir);
            self.clone_full().context("git clone не удался")?;
            self.narrow_cache();
        }
        if !self.clone_dir.join(SDR_DIR).is_dir() {
            anyhow::bail!("в клоне {} нет папки {SDR_DIR}", self.clone_dir.display());
        }
        Ok(())
    }

    /// Разреженный (sparse) клон: в рабочем дереве только `data_seed/`.
    /// `--filter=blob:none` не даёт скачивать файлы, которых нет среди выбранных путей.
    fn clone_data(&self) -> Result<()> {
        let dir = self.clone_dir.to_string_lossy().into_owned();
        git_ok(
            None,
            &[
                "clone",
                "--depth",
                "1",
                "--filter=blob:none",
                "--sparse",
                "--branch",
                &self.branch,
                &self.url,
                &dir,
            ],
        )?;
        git_ok(Some(&self.clone_dir), &["sparse-checkout", "set", SDR_DIR])?;
        Ok(())
    }

    /// Обычный клон — только как запасной путь для старых git/серверов без partial clone.
    fn clone_full(&self) -> Result<()> {
        let dir = self.clone_dir.to_string_lossy().into_owned();
        git_ok(
            None,
            &[
                "clone",
                "--depth",
                "1",
                "--branch",
                &self.branch,
                &self.url,
                &dir,
            ],
        )
    }

    /// Сузить кэш, созданный прежними сборками (полный клон всего проекта), до `data_seed/`.
    /// Работаем только с собственным мелким клоном: рабочий репозиторий пользователя не трогаем.
    fn narrow_cache(&self) {
        if !self.is_own_shallow_clone() {
            return;
        }
        let sparse = git_output(Some(&self.clone_dir), &["config", "--get", "core.sparseCheckout"]);
        if sparse.as_deref().map(|s| s.trim() == "true").unwrap_or(false) {
            return;
        }
        match git_ok(Some(&self.clone_dir), &["sparse-checkout", "set", SDR_DIR]) {
            Ok(()) => tracing::info!("кэш SDR сужен до {SDR_DIR}: исходники проекта из кэша убраны"),
            Err(e) => tracing::warn!("не удалось сузить кэш SDR до {SDR_DIR} ({e:#}) — оставляю как есть"),
        }
    }

    /// Мелкий клон (созданный нами) и именно в `clone_dir` — не чужой рабочий репозиторий.
    fn is_own_shallow_clone(&self) -> bool {
        let shallow = git_output(Some(&self.clone_dir), &["rev-parse", "--is-shallow-repository"]);
        if shallow.as_deref().map(str::trim) != Some("true") {
            return false;
        }
        let (Some(top), Ok(dir)) = (
            git_output(Some(&self.clone_dir), &["rev-parse", "--show-toplevel"]),
            self.clone_dir.canonicalize(),
        ) else {
            return false;
        };
        Path::new(top.trim()).canonicalize().map(|p| p == dir).unwrap_or(false)
    }

    /// Обновить кэш. Нет сети — не ошибка: работаем с тем, что уже скачано.
    fn pull(&self) {
        if let Err(e) = git_ok(Some(&self.clone_dir), &["pull", "--ff-only"]) {
            tracing::warn!("обновление кэша SDR не удалось ({e:#}) — использую локальную копию");
        }
    }
}

impl SdrSource for GitSdrSource {
    fn list_files(&self) -> Result<Vec<String>> {
        self.ensure_cloned()?;
        let data_dir = self.clone_dir.join(SDR_DIR);
        let mut files = Vec::new();
        collect_files(&data_dir, &mut files, &data_dir)?;
        Ok(files)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        self.ensure_cloned()?;
        reject_escape(path)?;
        let full = self.clone_dir.join(SDR_DIR).join(path);
        std::fs::read(&full).with_context(|| format!("не удалось прочитать {path} из SDR (Git)"))
    }

    fn refresh(&self) -> Result<()> {
        self.ensure_cloned()?;
        self.pull();
        Ok(())
    }
}

/// Источник: локальная папка на диске.
pub struct LocalSdrSource {
    base: PathBuf,
}

impl LocalSdrSource {
    pub fn new(base: &Path) -> Self {
        Self { base: base.to_path_buf() }
    }
}

impl SdrSource for LocalSdrSource {
    fn list_files(&self) -> Result<Vec<String>> {
        let mut files = Vec::new();
        collect_files(&self.base, &mut files, &self.base)?;
        Ok(files)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        reject_escape(path)?;
        let full = self.base.join(path);
        std::fs::read(&full).with_context(|| format!("не удалось прочитать {path} из локального SDR"))
    }
}

/// Fallback: встроенные данные (RustEmbed). Используется только если Git и локальная папка недоступны.
pub struct EmbeddedSdrSource;

impl SdrSource for EmbeddedSdrSource {
    fn list_files(&self) -> Result<Vec<String>> {
        Ok(crate::store::seed::SEED_FILES.iter().map(|(f, _)| f.to_string()).collect())
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        use rust_embed::RustEmbed;
        #[derive(RustEmbed)]
        #[folder = "$CARGO_MANIFEST_DIR/data_seed/"]
        struct EmbeddedFiles;
        let file = EmbeddedFiles::get(path)
            .ok_or_else(|| anyhow::anyhow!("файл {path} не найден во встроенных данных SDR"))?;
        Ok(file.data.into_owned())
    }
}

/// Путь из манифеста не должен выводить за пределы папки данных (`../…`).
fn reject_escape(path: &str) -> Result<()> {
    if path.split(['/', '\\']).any(|seg| seg == "..") {
        anyhow::bail!("недопустимый путь в SDR: {path}");
    }
    Ok(())
}

/// Запустить git (`cwd = None` — текущая директория процесса). Вывод перехватывается.
fn git(cwd: Option<&Path>, args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = std::process::Command::new("git");
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.args(args).output().context("не удалось запустить git")
}

/// Запустить git и превратить ненулевой код возврата в ошибку с его stderr.
fn git_ok(cwd: Option<&Path>, args: &[&str]) -> Result<()> {
    let out = git(cwd, args)?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    anyhow::bail!("git {} — {}", args.join(" "), err.trim())
}

/// Вывод успешной git-команды (без завершающего перевода строки); ошибка — `None`.
fn git_output(cwd: Option<&Path>, args: &[&str]) -> Option<String> {
    let out = git(cwd, args).ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Рекурсивно собрать все файлы в папке (кроме .git).
fn collect_files(dir: &Path, out: &mut Vec<String>, base: &Path) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some(".git") {
                continue;
            }
            collect_files(&path, out, base)?;
        } else if path.is_file() {
            if let Ok(rel) = path.strip_prefix(base) {
                if let Some(s) = rel.to_str() {
                    out.push(s.to_string());
                }
            }
        }
    }
    Ok(())
}

/// Фабрика: источник SDR из конфигурации. Режим обновления берётся из `sdr.update`.
pub fn make_source(cfg: &crate::config::Config) -> Box<dyn SdrSource> {
    let update = if cfg.sdr.always_update() { SdrUpdate::Always } else { SdrUpdate::Once };
    make_source_with(cfg, update)
}

/// Источник для принудительного обновления со страницы root: Git обновляется всегда.
pub fn make_source_for_refresh(cfg: &crate::config::Config) -> Box<dyn SdrSource> {
    make_source_with(cfg, SdrUpdate::Always)
}

fn make_source_with(cfg: &crate::config::Config, update: SdrUpdate) -> Box<dyn SdrSource> {
    if cfg.sdr.enabled {
        Box::new(GitSdrSource::new(
            &cfg.sdr.git_url,
            &cfg.sdr.git_branch,
            Path::new(&cfg.sdr.clone_dir),
            update,
        ))
    } else if Path::new(&cfg.sdr.local_path).exists() {
        Box::new(LocalSdrSource::new(Path::new(&cfg.sdr.local_path)))
    } else {
        Box::new(EmbeddedSdrSource)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Временная папка для теста, удаляется при выходе.
    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn temp_dir(name: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!("sdr_source_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    #[test]
    fn collect_files_skips_git_dir() {
        use std::fs::{self, DirBuilder};
        use std::io::Write;
        let tmp = std::env::temp_dir().join(format!("sdr_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        DirBuilder::new().recursive(true).create(&tmp.join("sub/.git")).unwrap();
        fs::File::create(tmp.join("a.json")).unwrap().write_all(b"{}").unwrap();
        fs::File::create(tmp.join("sub/b.json")).unwrap().write_all(b"{}").unwrap();
        fs::File::create(tmp.join("sub/.git/config")).unwrap().write_all(b"[core]").unwrap();

        let mut files = Vec::new();
        collect_files(&tmp, &mut files, &tmp).unwrap();
        assert!(files.iter().any(|f| f == "a.json"), "{files:?}");
        assert!(files.iter().any(|f| f == "sub/b.json"), "{files:?}");
        assert!(!files.iter().any(|f| f.starts_with(".git")), "{files:?}");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// Кэш уже есть — источник читает файлы из `data_seed/` без сети (git-команды просто не срабатывают).
    #[test]
    fn git_source_reads_cached_data_seed_only() {
        use std::fs;
        use std::io::Write;
        let tmp = temp_dir("cache");
        let cache = tmp.0.join("cache");
        fs::create_dir_all(cache.join("data_seed/sub")).unwrap();
        fs::create_dir_all(cache.join(".git")).unwrap();
        fs::File::create(cache.join("data_seed/skills.json")).unwrap().write_all(b"[]").unwrap();
        fs::File::create(cache.join("data_seed/sub/x.json")).unwrap().write_all(b"{}").unwrap();
        fs::File::create(cache.join("Cargo.toml")).unwrap().write_all(b"[package]").unwrap();

        let src = GitSdrSource::new("https://example.invalid/none.git", "main", &cache, SdrUpdate::Once);
        assert_eq!(src.read_file("skills.json").unwrap(), b"[]");
        let mut files = src.list_files().unwrap();
        files.sort();
        assert_eq!(files, vec!["skills.json".to_string(), "sub/x.json".to_string()]);
    }

    /// Нет файла в кэше — ошибка называет путь, справочник не «молча пустой».
    #[test]
    fn missing_file_is_reported_with_its_path() {
        use std::fs;
        let tmp = temp_dir("missing");
        let cache = tmp.0.join("cache");
        fs::create_dir_all(cache.join("data_seed")).unwrap();
        fs::create_dir_all(cache.join(".git")).unwrap();
        let src = GitSdrSource::new("https://example.invalid/none.git", "main", &cache, SdrUpdate::Once);
        let err = format!("{:#}", src.read_file("srd_2014.json").unwrap_err());
        assert!(err.contains("srd_2014.json"), "{err}");
    }

    #[test]
    fn paths_outside_data_dir_are_rejected() {
        assert!(reject_escape("builtin/map_01.jpg").is_ok());
        assert!(reject_escape("../../etc/passwd").is_err());
        assert!(reject_escape("builtin\\..\\..\\secret").is_err());
    }

    #[test]
    fn update_mode_follows_config() {
        use crate::config::Config;
        let mut cfg = Config::default();
        assert_eq!(cfg.sdr.update, "once");
        assert!(!cfg.sdr.always_update());
        cfg.sdr.update = "Always".into();
        assert!(cfg.sdr.always_update());
        cfg.sdr.update = "чинить".into();
        assert!(!cfg.sdr.always_update());
    }
}
