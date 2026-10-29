const TARGET_SAMPLE_RATE = 16_000;

export function encode16kMonoWav(audio: AudioBuffer): Blob {
  if (!audio.numberOfChannels || !audio.length || audio.sampleRate <= 0) {
    throw new Error('Audio buffer is empty or invalid.');
  }
  const outputLength = Math.floor(audio.length * TARGET_SAMPLE_RATE / audio.sampleRate);
  if (outputLength <= 0) throw new Error('Audio buffer is too short to encode.');
  const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index));
  const pcm = new ArrayBuffer(44 + outputLength * 2);
  const view = new DataView(pcm);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, 36 + outputLength * 2, true);
  writeText(8, 'WAVE');
  writeText(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, outputLength * 2, true);

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * audio.sampleRate / TARGET_SAMPLE_RATE;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, audio.length - 1);
    const fraction = sourcePosition - leftIndex;
    let sample = channels.reduce((sum, channel) => {
      const interpolated = channel[leftIndex] * (1 - fraction) + channel[rightIndex] * fraction;
      return sum + interpolated;
    }, 0) / channels.length;
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([pcm], { type: 'audio/wav' });
}
