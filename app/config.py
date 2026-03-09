from pathlib import Path
import yaml

# Resolve project root directory
BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "configs" / "settings.yaml"


def load_config() -> dict:
    # Load and parse YAML configuration
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)