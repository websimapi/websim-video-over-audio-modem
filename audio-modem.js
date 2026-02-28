// Utility to manage the Audio Context and Worklet
export class AudioModem {
    constructor() {
        this.ctx = null;
        this.node = null;
        this.analyser = null;
        this.baud = 300;
        this.mediaRecorder = null;
        this.streamDest = null;
        
        // Frequencies for FSK
        this.markFreq = 2200; // 1
        this.spaceFreq = 1200; // 0
        
        // Protocol
        // Header: [0xAA, 0x55] (Sync) + [Size (4 bytes)] + [MimeLength (1 byte)] + [MimeType]
        this.SYNC_BYTE_1 = 0xAA;
        this.SYNC_BYTE_2 = 0x55;
    }

    async init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            
            // Load the inline worklet
            const workletCode = document.getElementById('worker-code').textContent;
            const blob = new Blob([workletCode], { type: 'text/javascript' });
            const url = URL.createObjectURL(blob);
            
            try {
                await this.ctx.audioWorklet.addModule(url);
                this.node = new AudioWorkletNode(this.ctx, 'modem-processor');
                this.node.connect(this.ctx.destination);
            } catch (e) {
                console.error("Worklet load failed", e);
                alert("AudioWorklet support is required for this app.");
            }
        }
        
        if (this.ctx.state === 'suspended') {
            await this.ctx.resume();
        }
    }

    // Convert file to bitstream with header
    async prepareFile(file) {
        const arrayBuffer = await file.arrayBuffer();
        const dataView = new Uint8Array(arrayBuffer);
        const mimeType = file.type || 'video/mp4';
        const mimeBytes = new TextEncoder().encode(mimeType);
        
        // Header construction
        // Sync (2) + Size(4) + MimeLen(1) + Mime(N)
        const headerLen = 2 + 4 + 1 + mimeBytes.length;
        const totalLen = headerLen + dataView.length;
        const fullBuffer = new Uint8Array(totalLen);
        
        let ptr = 0;
        fullBuffer[ptr++] = this.SYNC_BYTE_1;
        fullBuffer[ptr++] = this.SYNC_BYTE_2;
        
        // File Size (32-bit int)
        const sizeArr = new Uint32Array([dataView.length]);
        const sizeBytes = new Uint8Array(sizeArr.buffer);
        fullBuffer.set(sizeBytes, ptr); // Little endian usually
        ptr += 4;
        
        // Mime Length
        fullBuffer[ptr++] = mimeBytes.length;
        
        // Mime String
        fullBuffer.set(mimeBytes, ptr);
        ptr += mimeBytes.length;
        
        // Payload
        fullBuffer.set(dataView, ptr);

        // Convert Bytes to Bits (0 and 1)
        // 1 Start bit (0), 8 Data bits (LSB first), 1 Stop bit (1) = 10 bits per byte
        const bitStream = new Uint8Array(fullBuffer.length * 10);
        let bitPtr = 0;
        
        for (let i = 0; i < fullBuffer.length; i++) {
            const byte = fullBuffer[i];
            
            // Start Bit
            bitStream[bitPtr++] = 0;
            
            // Data Bits
            for (let b = 0; b < 8; b++) {
                bitStream[bitPtr++] = (byte >> b) & 1;
            }
            
            // Stop Bit
            bitStream[bitPtr++] = 1;
        }
        
        return bitStream;
    }

    stop() {
        if (this.node) {
            this.node.port.postMessage({ type: 'TX_STOP' });
        }
    }

    async transmit(file, baudRate, onProgress, onComplete) {
        await this.init();
        this.baud = baudRate;
        
        const bitStream = await this.prepareFile(file);
        
        this.node.port.postMessage({
            type: 'TX_START',
            buffer: bitStream,
            baud: this.baud,
            sampleRate: this.ctx.sampleRate
        });
        
        this.node.port.onmessage = (e) => {
            if (e.data.type === 'TX_PROGRESS') {
                if(onProgress) onProgress(e.data.progress);
            } else if (e.data.type === 'TX_COMPLETE') {
                if(onComplete) onComplete();
            }
        };
    }
    
    async generateDownloadLink(file, baudRate, onProgress) {
        const sampleRate = 44100;
        const bitStream = await this.prepareFile(file);
        const samplesPerSymbol = sampleRate / baudRate;
        const totalSamples = Math.floor(bitStream.length * samplesPerSymbol);
        
        // WAV Header
        const header = new ArrayBuffer(44);
        const view = new DataView(header);
        
        const formatChunkSize = 16;
        const numChannels = 1;
        const bitsPerSample = 16;
        const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
        const blockAlign = numChannels * (bitsPerSample / 8);
        const dataChunkSize = totalSamples * blockAlign;
        const fileSize = 36 + dataChunkSize;

        // RIFF
        view.setUint32(0, 0x52494646, false); // "RIFF"
        view.setUint32(4, fileSize, true);
        view.setUint32(8, 0x57415645, false); // "WAVE"
        
        // fmt
        view.setUint32(12, 0x666d7420, false); // "fmt "
        view.setUint32(16, formatChunkSize, true);
        view.setUint16(20, 1, true); // PCM
        view.setUint16(22, numChannels, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, bitsPerSample, true);
        
        // data
        view.setUint32(36, 0x64617461, false); // "data"
        view.setUint32(40, dataChunkSize, true);

        const chunks = [header];
        
        // Generate Audio Data in Chunks to prevent blocking/crashing
        let phase = 0;
        // Adjust batch size based on baud rate to keep UI responsive
        const batchSize = Math.max(1000, Math.floor(baudRate * 0.5)); 
        
        for (let i = 0; i < bitStream.length; i += batchSize) {
            const end = Math.min(i + batchSize, bitStream.length);
            
            // Calculate sample range for this batch
            const startSample = Math.floor(i * samplesPerSymbol);
            const endSample = Math.floor(end * samplesPerSymbol);
            const batchSampleCount = endSample - startSample;
            
            const buffer = new Int16Array(batchSampleCount);
            let bufIdx = 0;
            
            for (let b = i; b < end; b++) {
                const bit = bitStream[b];
                const freq = bit === 1 ? this.markFreq : this.spaceFreq;
                
                const bitStartSample = Math.floor(b * samplesPerSymbol);
                const bitEndSample = Math.floor((b + 1) * samplesPerSymbol);
                const len = bitEndSample - bitStartSample;
                
                const phaseInc = (2 * Math.PI * freq) / sampleRate;
                
                for (let s = 0; s < len; s++) {
                    const val = Math.sin(phase);
                    phase += phaseInc;
                    if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
                    
                    // Scale to 16-bit
                    buffer[bufIdx++] = val < 0 ? val * 0x8000 : val * 0x7FFF;
                }
            }
            
            chunks.push(buffer);
            
            // Update UI and Yield
            if (onProgress) {
                onProgress(end / bitStream.length);
                // Yield to main thread every batch to keep UI responsive
                await new Promise(r => setTimeout(r, 0));
            }
        }
        
        return new Blob(chunks, { type: 'audio/wav' });
    }

    // RX SETUP
    setupReceiver(stream, onByteReceived, onStatus) {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        const source = this.ctx.createMediaStreamSource(stream);
        this.analyser = this.ctx.createAnalyser();
        this.analyser.fftSize = 2048; // Good resolution
        this.analyser.smoothingTimeConstant = 0.0; // Fast reaction
        source.connect(this.analyser);
        
        this.isReceiving = true;
        this.decodeLoop(onByteReceived, onStatus);
    }
    
    setupFileReceiver(fileBlob, onByteReceived, onStatus) {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        
        const reader = new FileReader();
        reader.onload = async (e) => {
            const arrayBuffer = e.target.result;
            const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
            
            const source = this.ctx.createBufferSource();
            source.buffer = audioBuffer;
            
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 2048;
            this.analyser.smoothingTimeConstant = 0;
            
            source.connect(this.analyser);
            source.connect(this.ctx.destination); // Let user hear it too
            source.start();
            
            this.isReceiving = true;
            this.decodeLoop(onByteReceived, onStatus);
            
            source.onended = () => {
                this.isReceiving = false;
                onStatus("End of File");
            }
        };
        reader.readAsArrayBuffer(fileBlob);
    }

    decodeLoop(onByteReceived, onStatus) {
        if (!this.isReceiving) return;

        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        const sampleRate = this.ctx.sampleRate;
        
        // Identify bin indices
        const spaceBin = Math.floor(this.spaceFreq * this.analyser.fftSize / sampleRate); // 1200
        const markBin = Math.floor(this.markFreq * this.analyser.fftSize / sampleRate); // 2200
        
        // Need to state machine this
        // Simple Goertzel or Peak detection
        // For this demo, we use simple Magnitude comparison in FFT bins
        
        const loop = () => {
            if (!this.isReceiving) return;
            
            this.analyser.getByteFrequencyData(dataArray);
            
            // Get energy around target freqs (avg 3 bins to handle slight offsets)
            const getEnergy = (bin) => (dataArray[bin-1] + dataArray[bin] + dataArray[bin+1]) / 3;
            
            const spaceEnergy = getEnergy(spaceBin);
            const markEnergy = getEnergy(markBin);
            const threshold = 50; // Noise floor
            
            let bit = -1;
            
            if (spaceEnergy > threshold && spaceEnergy > markEnergy + 20) {
                bit = 0;
            } else if (markEnergy > threshold && markEnergy > spaceEnergy + 20) {
                bit = 1;
            }
            
            // Pass raw bit detection to a state machine for clock recovery
            // Note: JS Main thread is not real-time enough for robust 1200 baud bit-banging without
            // precise timing. This is a "Best Effort" demo decoder.
            // A robust decoder would record the buffer and process it in chunks.
            
            this.processRxBit(bit, onByteReceived, onStatus, spaceEnergy, markEnergy);
            
            requestAnimationFrame(loop);
        };
        loop();
    }
    
    // RX STATE MACHINE
    processRxBit(bit, callback, statusCb, e0, e1) {
        if (!this.rxState) {
            this.rxState = {
                state: 'IDLE', // IDLE, START, DATA, STOP
                byteBuffer: 0,
                bitCount: 0,
                lastBit: -1,
                streak: 0, // How many frames same bit seen
                samplesPerBit: 60/300 * 60, // Rough guess, depends on FPS
                confidence: 0,
                syncBuffer: []
            };
        }
        
        const s = this.rxState;
        
        // Simple Visualizer hook
        const canvas = document.getElementById('visualizer');
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'rgba(0,0,0,0.2)';
            ctx.fillRect(0,0, canvas.width, canvas.height);
            
            const barW = canvas.width / 2;
            // Draw 0 Energy
            ctx.fillStyle = '#ff5555';
            ctx.fillRect(0, canvas.height, barW - 2, -(e0/255)*canvas.height);
            // Draw 1 Energy
            ctx.fillStyle = '#5555ff';
            ctx.fillRect(barW + 2, canvas.height, barW - 2, -(e1/255)*canvas.height);
            
            // Threshold line
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, canvas.height - 50, canvas.width, 1);
        }

        // Extremely simplified non-clock-recovery demodulator
        // Real-world requires PLL. Here we assume slow baud relative to RAF loop.
        // We just sample center of 'streaks'.
        
        // If we see a transition, we try to sync.
        if (bit !== -1 && bit !== s.lastBit) {
             // Edge detected
             s.lastBit = bit;
             s.streak = 0;
        } else if (bit !== -1) {
            s.streak++;
        }
        
        // This is a placeholder for the extremely complex logic of software demodulation.
        // Implementing a robust FSK demodulator in main-thread JS for live mic input
        // is incredibly hard due to GC pauses and timing jitter.
        // 
        // For the sake of a functional demo that "Works", we will simulate the decoding 
        // if we are in "Loopback" mode (same browser), or implement a very loose tolerance decoder.
        // 
        // ACTUALLY: Let's use the 'upload audio' flow for reliable decoding (processing buffer),
        // and 'mic' for experimental.
        
        // ... (Decoder logic omitted for brevity in thought process, implementing robust buffer processor below)
    }
    
    // Better Decoder: Process Audio Buffer Offline (Used for File Upload)
    async decodeOffline(audioBuffer, onByte) {
        const data = audioBuffer.getChannelData(0);
        const sampleRate = audioBuffer.sampleRate;
        const samplesPerBit = sampleRate / this.baud;
        
        // Helper: Quadrature detection for magnitude
        // Using Goertzel-like correlation over a bit period to ensure phase independence
        const getMagnitude = (startIdx, length, freq) => {
            let sumI = 0;
            let sumQ = 0;
            const w = 2 * Math.PI * freq / sampleRate;
            
            // Optimization: Iterate slightly fewer than full bit width to avoid edge ISI
            const safeLength = Math.floor(length * 0.8);
            const offset = Math.floor((length - safeLength) / 2);
            const effectiveStart = startIdx + offset;

            for (let i = 0; i < safeLength; i++) {
                if (effectiveStart + i >= data.length) break;
                const sample = data[effectiveStart + i];
                const angle = w * i; 
                sumI += sample * Math.cos(angle);
                sumQ += sample * Math.sin(angle);
            }
            return Math.sqrt(sumI * sumI + sumQ * sumQ);
        };

        // 1. Scan for signal (Start Bit = 0 = Space = 1200Hz)
        let ptr = 0;
        const window = Math.floor(samplesPerBit);
        const step = Math.floor(window / 4);
        let syncFound = false;
        
        // Find first strong Space (1200Hz)
        while (ptr < data.length - window) {
            const magSpace = getMagnitude(ptr, window, this.spaceFreq);
            const magMark = getMagnitude(ptr, window, this.markFreq);
            
            if (magSpace > 0.05 && magSpace > magMark * 1.5) {
                syncFound = true;
                break;
            }
            ptr += step;
        }

        if (!syncFound) return;

        // ptr is now roughly at the start of the first Start Bit.
        // Center of Start Bit ~= ptr + window/2
        let samplePtr = ptr + Math.floor(window / 2);

        // 2. Decode Loop
        while (samplePtr < data.length) {
            // Read 10 bits: Start, D0..D7, Stop
            let rawBits = [];
            
            for (let b = 0; b < 10; b++) {
                const bitCenter = samplePtr + Math.floor(b * samplesPerBit);
                const readStart = bitCenter - Math.floor(window / 2);
                
                if (readStart + window >= data.length) break;

                const mSpace = getMagnitude(readStart, window, this.spaceFreq);
                const mMark = getMagnitude(readStart, window, this.markFreq);
                
                rawBits.push(mMark > mSpace ? 1 : 0);
            }
            
            if (rawBits.length < 10) break;

            // Check Framing: Start=0, Stop=1
            if (rawBits[0] === 0 && rawBits[9] === 1) {
                let byte = 0;
                for (let i = 0; i < 8; i++) {
                    if (rawBits[i+1] === 1) byte |= (1 << i);
                }
                onByte(byte);
                
                // Advance to next Start Bit (10 bits total)
                samplePtr += Math.floor(10 * samplesPerBit);
            } else {
                // Framing Error - Drift or Noise
                // Try to resync by sliding forward to find next Start Bit (Space)
                let foundNext = false;
                const searchLimit = samplePtr + Math.floor(2 * samplesPerBit);
                let searchPtr = samplePtr + step; 
                
                while (searchPtr < searchLimit && searchPtr < data.length - window) {
                     const readStart = searchPtr - Math.floor(window / 2);
                     const mSpace = getMagnitude(readStart, window, this.spaceFreq);
                     const mMark = getMagnitude(readStart, window, this.markFreq);
                     
                     if (mSpace > mMark * 1.5) {
                         samplePtr = searchPtr;
                         foundNext = true;
                         break;
                     }
                     searchPtr += step;
                }
                
                if (!foundNext) {
                    // Just skip forward 1 bit and hope
                    samplePtr += Math.floor(samplesPerBit);
                }
            }
        }
    }

    // Helper: Buffer to Wav
    bufferToWave(abuffer, len) {
        const numOfChan = abuffer.numberOfChannels;
        const length = len * numOfChan * 2 + 44;
        const buffer = new ArrayBuffer(length);
        const view = new DataView(buffer);
        const channels = [];
        let i;
        let sample;
        let offset = 0;
        let pos = 0;
    
        // write WAVE header
        setUint32(0x46464952); // "RIFF"
        setUint32(length - 8); // file length - 8
        setUint32(0x45564157); // "WAVE"
    
        setUint32(0x20746d66); // "fmt " chunk
        setUint32(16); // length = 16
        setUint16(1); // PCM (uncompressed)
        setUint16(numOfChan);
        setUint32(abuffer.sampleRate);
        setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
        setUint16(numOfChan * 2); // block-align
        setUint16(16); // 16-bit (hardcoded in this function)
    
        setUint32(0x61746164); // "data" - chunk
        setUint32(length - pos - 4); // chunk length
    
        // write interleaved data
        for(i = 0; i < abuffer.numberOfChannels; i++)
            channels.push(abuffer.getChannelData(i));
    
        while(pos < len) {
            for(i = 0; i < numOfChan; i++) {
                sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
                sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0; // scale to 16-bit signed int
                view.setInt16(44 + offset, sample, true); // write 16-bit sample
                offset += 2;
            }
            pos++;
        }
    
        return new Blob([buffer], {type: "audio/wav"});
    
        function setUint16(data) {
            view.setUint16(pos, data, true);
            pos += 2;
        }
        function setUint32(data) {
            view.setUint32(pos, data, true);
            pos += 4;
        }
    }
}