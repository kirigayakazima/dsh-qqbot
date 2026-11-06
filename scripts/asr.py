"""Transcribe one QQ voice note with the phone's SenseVoice model."""

import json
from pathlib import Path
import subprocess
import sys


def main():
    voice_home = Path.home() / '.dsh' / 'voice'
    sys.path.insert(0, str(voice_home / 'lib'))
    import numpy as np
    import sherpa_onnx

    sample_rate = 16000
    audio = sys.stdin.buffer.read()
    if '--pcm' not in sys.argv:
        audio = subprocess.run(
            ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
             '-f', 's16le', '-ac', '1', '-ar', str(sample_rate), 'pipe:1'],
            input=audio, capture_output=True, check=True,
        ).stdout
    samples = np.frombuffer(audio, dtype='<i2').astype(np.float32) / 32768
    model_dir = voice_home / 'models' / 'sensevoice'
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(model_dir / 'model.int8.onnx'), tokens=str(model_dir / 'tokens.txt'),
        use_itn=True, num_threads=2,
    )
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)
    print(json.dumps({'text': stream.result.text.strip(), 'duration': round(len(samples) / sample_rate, 2)}))


if __name__ == '__main__':
    main()
