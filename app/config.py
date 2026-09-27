from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite+aiosqlite:///./data/dnd.db"
    host: str = "0.0.0.0"
    port: int = 8080
    secret_key: str = "change-me"

    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "noreply@example.com"
    dev_show_code: bool = True

    # Максимальная сторона изображения при сжатии
    image_max_side: int = 2048
    image_quality: int = 82


settings = Settings()
