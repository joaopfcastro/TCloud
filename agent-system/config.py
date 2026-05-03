import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MEMORY_FILE = os.path.join(BASE_DIR, "memory.json")
VECTOR_DIR = os.path.join(BASE_DIR, "vector_store")
FINAL_MD_DIR = os.path.join(BASE_DIR, "final_md")
