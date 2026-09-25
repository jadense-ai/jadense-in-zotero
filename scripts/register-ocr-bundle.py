"""登记构建清单；只有远端包匿名下载且摘要匹配后才激活普通版自动下载。"""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request


def register(manifest, urls, output):
    entry = json.loads(manifest.read_text(encoding='utf-8'))
    for url in urls:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.username or parsed.password:
            raise ValueError('A public HTTPS package URL is required')
        digest, size = hashlib.sha256(), 0
        with urllib.request.urlopen(url, timeout=120) as response:
            while block := response.read(1024 * 1024):
                digest.update(block); size += len(block)
        if digest.hexdigest() != entry['sha256'] or size != entry['size']:
            raise ValueError('Remote package does not match the build manifest')
    entry['published'] = bool(urls)
    entry['urls'] = urls
    output.write_text(json.dumps({entry['platform']: entry}, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--url', action='append', default=[])
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'content/ocr/bundles.json')
    args = parser.parse_args()
    register(args.manifest, args.url, args.output)
