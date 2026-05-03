import chromadb
from config import VECTOR_DIR

client = chromadb.PersistentClient(path=VECTOR_DIR)
collection = client.get_or_create_collection(name="agent_memory")

def add_memory(document, metadata):
    doc_id = str(abs(hash(document + str(metadata))))
    collection.upsert(
        ids=[doc_id],
        documents=[document],
        metadatas=[metadata]
    )

def search_memory(query, n_results=5):
    try:
        results = collection.query(query_texts=[query], n_results=n_results)
        docs = results.get("documents", [])
        if docs and len(docs) > 0:
            return docs[0]
        return []
    except Exception:
        return []
