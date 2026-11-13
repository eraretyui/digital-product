"""Single-request JSON bridge. No network, shell, models or arbitrary paths."""
import sys
import os
import json
import uuid
import hashlib
from pathlib import Path

PROJECT = Path(__file__).resolve().parent
WORKSPACE = PROJECT
sys.path.insert(0, str(PROJECT / '.deps' / 'faiss'))
os.environ.setdefault('OMP_NUM_THREADS', '1')


def bounded(path):
    value = Path(path).resolve()
    if not value.is_relative_to(WORKSPACE) or value == WORKSPACE:
        raise ValueError('Vector data path must be inside workspace')
    if value.is_relative_to(PROJECT / '.deps'):
        raise ValueError('Runtime index must not be stored in .deps')
    return value


def execute(request):
    import numpy as np
    import faiss
    faiss.omp_set_num_threads(1)
    op = request.get('op')
    if op == 'probe':
        return {'engine': 'faiss-cpu', 'fallback': False, 'version': faiss.__version__, 'indexType': 'IndexFlatIP'}
    directory = bounded(request['directory'])
    directory.mkdir(parents=True, exist_ok=True)
    index_path = bounded(directory / 'index.faiss')
    meta_path = bounded(directory / 'index-meta.json')
    if op == 'build':
        rows = request['vectors']
        metadata = request['metadata']
        if not rows or len(rows) != len(metadata):
            raise ValueError('Nonempty equal-sized vectors and metadata required')
        vectors = np.asarray(rows, dtype='float32')
        if vectors.ndim != 2 or vectors.shape[1] < 1 or not np.isfinite(vectors).all():
            raise ValueError('Invalid vectors')
        if np.any(np.linalg.norm(vectors, axis=1) == 0):
            raise ValueError('Zero vectors cannot be normalized')
        faiss.normalize_L2(vectors)
        index = faiss.IndexFlatIP(vectors.shape[1])
        index.add(vectors)
        info = {'fingerprint': request['fingerprint'], 'count': len(rows), 'dimension': vectors.shape[1], 'metadata': metadata}
        temporary = bounded(directory / ('index-' + uuid.uuid4().hex + '.tmp'))
        # Serialize through bytes: Windows FAISS C++ file I/O can fail on Cyrillic paths.
        index_bytes = faiss.serialize_index(index).tobytes()
        info['indexSha256'] = hashlib.sha256(index_bytes).hexdigest()
        temporary.write_bytes(index_bytes)
        os.replace(temporary, index_path)
        temporary = bounded(directory / ('meta-' + uuid.uuid4().hex + '.tmp'))
        temporary.write_text(json.dumps(info, ensure_ascii=False), encoding='utf-8')
        os.replace(temporary, meta_path)
        return {'engine': 'faiss-cpu', 'fallback': False, 'version': faiss.__version__, 'count': len(rows), 'dimension': vectors.shape[1]}
    if op == 'query':
        info = json.loads(meta_path.read_text(encoding='utf-8'))
        if info['fingerprint'] != request['fingerprint']:
            raise ValueError('Index fingerprint does not match current corpus')
        # Only read our fixed path, never accept an index path from request data.
        index_bytes = index_path.read_bytes()
        if hashlib.sha256(index_bytes).hexdigest() != info.get('indexSha256'):
            raise ValueError('Index checksum mismatch; rebuild required')
        index = faiss.deserialize_index(np.frombuffer(index_bytes, dtype='uint8').copy())
        if index.d != info['dimension'] or index.ntotal != info['count']:
            raise ValueError('Index and metadata mismatch')
        vector = np.asarray([request['vector']], dtype='float32')
        if vector.shape != (1, index.d) or not np.isfinite(vector).all() or np.linalg.norm(vector) == 0:
            raise ValueError('Invalid query vector')
        faiss.normalize_L2(vector)
        k = min(max(int(request.get('k', 4)), 1), index.ntotal, 100)
        scores, indices = index.search(vector, k)
        return {'engine': 'faiss-cpu', 'fallback': False, 'count': index.ntotal, 'dimension': index.d,
                'hits': [{'index': int(i), 'score': float(score), 'metadata': info['metadata'][int(i)]}
                         for score, i in zip(scores[0], indices[0]) if i >= 0]}
    raise ValueError('Unknown vector operation')


if __name__ == '__main__':
    try:
        raw = sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
        if len(raw) > 64 * 1024 * 1024:
            raise ValueError('Request too large')
        result = execute(json.loads(raw.decode('utf-8')))
        sys.stdout.buffer.write(json.dumps({'ok': True, **result}, ensure_ascii=False, allow_nan=False).encode('utf-8'))
    except Exception as error:
        sys.stdout.buffer.write(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False).encode('utf-8'))
        sys.exit(1)
