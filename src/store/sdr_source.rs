//! Источник данных SDR (базовый справочник): Git-репозиторий, локальная папка или встроенный (fallback).
//! Данные НЕ вшиты в бинарник — загружаются извне при старте.
//! Использует git CLI (std::process::Command), чтобы не добавлять зависимости git2 (crates.io недоступен локально).

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Абстракция над источником файлов SDR.
pub trait SdrSource: Send + Sync {
    /// Список всех файлов в источнике (относительные пути).
    fn list_files(&self) -> Result<Vec<String>>;
    /// Прочитать файл по относительному пути.
    fn read_file(&self, path: &str) -> Result<Vec<u8>>;
}

/// Источник: Git-репозиторий. Клонируется в локальную папку при первом обращении.
pub struct GitSdrSource {
    url: String,
    branch: String,
    clone_dir: PathBuf,
}

impl GitSdrSource {
    pub fn new(url: &str, branch: &str, clone_dir: &Path) -> Self {
        Self {
            url: url.to_string(),
            branch: branch.to_string(),
            clone_dir: clone_dir.to_path_buf(),
        }
    }

    /// Убедиться, что репозиторий склонирован (или обновлён через pull).
    fn ensure_cloned(&self) -> Result<()> {
        if self.clone_dir.join(".git").exists() {
            // Уже клонировано — пытаемся обновить (не критично, если не получилось).
            let _ = std::process::Command::new("git")
                .current_dir(&self.clone_dir)
                .args(["pull", "--ff-only"])
                .output();
            return Ok(());
        }
        // Первое клонирование.
        if let Some(parent) = self.clone_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let status = std::process::Command::new("git")
            .args([
                "clone",
                "--depth",
                "1",
                "--branch",
                &self.branch,
                &self.url,
                &self.clone_dir.to_string_lossy(),
            ])
            .status()
            .context("не удалось запустить git clone")?;
        if !status.success() {
            anyhow::bail!("git clone не удался (код {status:?})");
        }
        Ok(())
    }
}

impl SdrSource for GitSdrSource {
    fn list_files(&self) -> Result<Vec<String>> {
        self.ensure_cloned()?;
        let mut files = Vec::new();
        collect_files(&self.clone_dir, &mut files, &self.clone_dir)?;
        Ok(files)
    }

    fn read_file(&self, path: &str) -> Result<Vec<u8>> {
        self.ensure_cloned()?;
        let full = self.clone_dir.join(path);
        std::fs::read(&full).with_context(|| format!("не удалось прочитать {path} из SDR (Git)"))
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

/// Фабрика: создать источник SDR из конфигурации.
pub fn make_source(cfg: &crate::config::Config) -> Box<dyn SdrSource> {
    if cfg.sdr.enabled {
        Box::new(GitSdrSource::new(
            &cfg.sdr.git_url,
            &cfg.sdr.git_branch,
            Path::new(&cfg.sdr.clone_dir),
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
}
