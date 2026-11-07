"""Export bounded runtime WebP assets from the recorded delivery commit.

Development-only tool. Requires Pillow 12.0.0 with libwebp 1.6.0.
Use --output with a new directory, inspect the result, then copy it to src/assets/maid.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile

import PIL
from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]
SOURCE = '463fac186619fcf1bbdb8746035fc2fb21c168e5'
OPTIONS = dict(format='WEBP', lossless=False, quality=90, method=4, exact=True)


def source_bytes(relative):
    return subprocess.check_output(['git', 'show', f'{SOURCE}:{relative}'], cwd=ROOT)


def encode(source, target):
    image = Image.open(io.BytesIO(source))
    frames, durations = [], []
    for index in range(image.n_frames):
        image.seek(index)
        image.load()
        if image.convert('RGBA').getextrema()[3] != (255, 255):
            raise ValueError('The delivered character assets must be opaque')
        frames.append(image.convert('RGB'))
        durations.append(image.info.get('duration', 0))
    options = dict(OPTIONS)
    if len(frames) > 1:
        options.update(save_all=True, append_images=frames[1:], duration=durations,
                       loop=image.info['loop'], background=image.info['background'], minimize_size=True)
    frames[0].save(target, **options)
    with Image.open(target) as decoded:
        if decoded.size != image.size or decoded.n_frames != len(frames):
            raise ValueError(f'Canvas or frame count changed for {target.name}')
        for index in range(len(frames)):
            decoded.seek(index)
            decoded.load()
            if decoded.info.get('duration', 0) != durations[index]:
                raise ValueError(f'Frame timing changed for {target.name}')
        if decoded.info.get('loop', 0) != image.info.get('loop', 0):
            raise ValueError(f'Loop count changed for {target.name}')
    return dict(size=list(image.size), frames=len(frames), durations=durations, loop=image.info.get('loop', 0))


def export(directory):
    for framing in ['', 'avatars']:
        relative = '/'.join(part for part in ['src/assets/maid', framing] if part)
        delivered = json.loads(source_bytes(f'{relative}/manifest.json'))
        output = directory / framing
        output.mkdir(exist_ok=True)
        manifest = dict(version=1, source=dict(repository='https://github.com/JNS0724/Viva',
                        revision=SOURCE, path=relative, exportRevision=delivered['revision'],
                        generationMode=delivered['generationMode']),
                        encoding=dict(pillow=PIL.__version__, libwebp=features.version('webp'),
                        lossless=False, quality=90, method=4, minimize_size=True),
                        background='#FAF7F2', alpha=False, states=[], sourceSha256={}, sha256={})
        for state in delivered['states']:
            still = f"{state['id']}.webp"
            motion = f"{state['id']}-motion.webp"
            metadata = {}
            for file in [still, motion]:
                source = source_bytes(f'{relative}/{file}')
                digest = hashlib.sha256(source).hexdigest()
                if digest != delivered['sha256'][f'webp/{file}']:
                    raise ValueError(f'Source digest mismatch for {relative}/{file}')
                metadata[file] = encode(source, output / file)
                manifest['sourceSha256'][file] = digest
                manifest['sha256'][file] = hashlib.sha256((output / file).read_bytes()).hexdigest()
            animation = metadata[motion]
            manifest['states'].append(dict(id=state['id'], static=still, animation=motion,
                staticSize=metadata[still]['size'], animationSize=animation['size'], frames=animation['frames'],
                durationsMs=animation['durations'], durationMs=sum(animation['durations']), loopCount=animation['loop']))
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    target = parser.parse_args().output.resolve()
    if PIL.__version__ != '12.0.0' or features.version('webp') != '1.6.0':
        parser.error('Use Pillow 12.0.0 with libwebp 1.6.0 to reproduce the recorded bytes')
    if target.exists():
        parser.error('Choose a new output directory')
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='viva-assets-', dir=target.parent) as temporary:
        staging = Path(temporary) / 'maid'
        staging.mkdir()
        export(staging)
        os.replace(staging, target)
    print(f'Exported 40 runtime WebP assets to {target}')


if __name__ == '__main__':
    main()
