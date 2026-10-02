# src/config/secrets.py
from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field, SecretStr
import os

class SecuritySettings(BaseSettings):
    database_url: SecretStr = Field(..., description="PostgreSQL secure connection string")
    signing_keypair_secret: SecretStr = Field(..., description="Stellar ed25519 signing keypair secret")
    api_key: SecretStr = Field(..., description="External service authorization token")
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )

def load_runtime_secrets() -> SecuritySettings:
    """Load and validate application secrets dynamically on startup."""
    # AWS Secrets Manager or HashiCorp Vault dynamic injection hook can be bound here
    try:
        settings = SecuritySettings()
        return settings
    except Exception as e:
        raise RuntimeError(f"Critical environment secret validation failed: {str(e)}")