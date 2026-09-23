/* Converts the browser capture rate into the provider's PCM16 mono rate. */
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetSampleRate;
    this.ratio = sampleRate / this.targetRate;
    this.frameLength = Math.round(this.targetRate * 0.04);
    this.frame = new Int16Array(this.frameLength);
    this.frameOffset = 0;
    this.carry = new Float32Array(0);
    this.position = 0;
    this.energy = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0].length) return true;
    const count = channels[0].length;
    const joined = new Float32Array(this.carry.length + count);
    joined.set(this.carry);
    for (let i = 0; i < count; i += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] || 0;
      joined[this.carry.length + i] = mono / channels.length;
    }
    while (this.position < joined.length - 1) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const value = Math.max(-1, Math.min(1,
        joined[left] * (1 - fraction) + joined[left + 1] * fraction));
      this.frame[this.frameOffset] = Math.round(value * (value < 0 ? 32768 : 32767));
      this.energy += value * value;
      this.frameOffset += 1;
      if (this.frameOffset === this.frameLength) {
        this.port.postMessage({ type: 'pcm', data: this.frame.buffer,
          rms: Math.sqrt(this.energy / this.frameLength) }, [this.frame.buffer]);
        this.frame = new Int16Array(this.frameLength);
        this.frameOffset = 0;
        this.energy = 0;
      }
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), joined.length);
    this.carry = joined.slice(consumed);
    this.position -= consumed;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
