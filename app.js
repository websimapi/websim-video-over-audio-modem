import { AudioModem } from './audio-modem.js';

const modem = new AudioModem();

// UI Elements
const dropArea = document.getElementById('drop-area');
const videoInput = document.getElementById('video-input');
const fileInfo = document.getElementById('file-info');
const txControls = document.getElementById('tx-controls');
const btnPlay = document.getElementById('btn-play');
const btnDownloadAudio = document.getElementById('btn-download-audio');
const txProgress = document.getElementById('tx-progress');
const txStatus = document.getElementById('tx-status');
const baudSelect = document.getElementById('baud-rate');
const qualitySelect = document.getElementById('quality-select');
const compressionPanel = document.getElementById('compression-panel');
const compressionProgress = document.getElementById('compression-progress');
const compressionStatusText = document.getElementById('compression-status-text');

const btnMic = document.getElementById('btn-mic');
const btnUploadAudio = document.getElementById('btn-upload-audio');
const audioInput = document.getElementById('audio-input');
const rxStatus = document.getElementById('rx-status');
const outputVideo = document.getElementById('output-video');
const downloadVideo = document.getElementById('download-video');
const resultArea = document.getElementById('result-area');

// State
let selectedFile = null;
let rxBuffer = []; // Bytes received
let rxHeader = null; // { size, mime }
let rxMode = 'IDLE';

// --- ENCODER EVENTS ---

dropArea.addEventListener('click', () => videoInput.click());

videoInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

dropArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropArea.style.borderColor = '#00ff88';
});

dropArea.addEventListener('dragleave', () => {
    dropArea.style.borderColor = '#444';
});

dropArea.addEventListener('drop', (e) => {
    e.preventDefault();
    dropArea.style.borderColor = '#444';
    if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
    selectedFile = file;
    document.getElementById('filename').textContent = file.name;
    document.getElementById('filesize').textContent = `(${(file.size/1024).toFixed(1)} KB)`;
    fileInfo.classList.remove('hidden');
    txControls.classList.remove('disabled');
    
    // Warning for large files
    if (file.size > 1000000) { // 1MB
        txStatus.textContent = "File > 1MB. Compression recommended.";
        txStatus.style.color = "orange";
        // Auto-select medium quality if large to encourage usage
        if(qualitySelect.value === 'original') qualitySelect.value = "medium";
    } else {
        txStatus.textContent = "Ready to encode.";
        txStatus.style.color = "#aaa";
    }
}

btnPlay.addEventListener('click', async () => {
    if (!selectedFile) return;
    
    // Stop any existing actions
    modem.stop();
    
    btnPlay.disabled = true;
    btnDownloadAudio.disabled = true;

    let fileToTransmit = selectedFile;
    
    // Check compression
    if (qualitySelect.value !== 'original') {
        try {
            fileToTransmit = await performCompression(selectedFile, qualitySelect.value);
        } catch (e) {
            console.error(e);
            txStatus.textContent = "Compression failed, using original.";
        }
    }
    
    txStatus.textContent = "Broadcasting Audio...";
    
    const baud = parseInt(baudSelect.value);
    
    await modem.transmit(fileToTransmit, baud, (progress) => {
        txProgress.style.width = `${progress * 100}%`;
        txStatus.textContent = `Broadcasting: ${Math.floor(progress * 100)}%`;
    }, () => {
        txStatus.textContent = "Broadcast Complete.";
        btnPlay.disabled = false;
        btnDownloadAudio.disabled = false;
        txProgress.style.width = '100%';
    });
});

btnDownloadAudio.addEventListener('click', async () => {
    if (!selectedFile) return;
    
    modem.stop(); // Stop playback if any
    
    btnDownloadAudio.disabled = true;
    btnPlay.disabled = true;

    let fileToTransmit = selectedFile;
    
    // Check compression
    if (qualitySelect.value !== 'original') {
        try {
            fileToTransmit = await performCompression(selectedFile, qualitySelect.value);
        } catch (e) {
            console.error(e);
            txStatus.textContent = "Compression failed, using original.";
        }
    }
    
    txStatus.textContent = "Generating audio file...";
    const baud = parseInt(baudSelect.value);
    
    try {
        const blob = await modem.generateDownloadLink(fileToTransmit, baud, (progress) => {
            txProgress.style.width = `${progress * 100}%`;
            txStatus.textContent = `Generating WAV: ${Math.floor(progress * 100)}%`;
        });
        
        if (blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${selectedFile.name.split('.')[0]}_audio.wav`;
            a.click();
            txStatus.textContent = "Audio saved.";
        }
    } catch (e) {
        console.error(e);
        txStatus.textContent = "Error generating file.";
    }
    
    btnDownloadAudio.disabled = false;
    btnPlay.disabled = false;
});

// --- COMPRESSION LOGIC ---

async function performCompression(file, quality) {
    return new Promise(async (resolve, reject) => {
        compressionPanel.classList.remove('hidden');
        compressionStatusText.textContent = "Preparing video compressor...";
        compressionProgress.style.width = '0%';
        
        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        
        await new Promise(r => {
            video.onloadedmetadata = r;
            video.src = URL.createObjectURL(file);
        });
        
        let targetWidth, targetFps, targetBitrate;
        
        switch(quality) {
            case 'medium': // 240p
                targetWidth = 240;
                targetFps = 15;
                targetBitrate = 150000; // 150kbps
                break;
            case 'low': // 144p
                targetWidth = 144;
                targetFps = 10;
                targetBitrate = 50000; // 50kbps
                break;
            case 'lowest': // 64p
                targetWidth = 64;
                targetFps = 5;
                targetBitrate = 15000; // 15kbps
                break;
            default:
                targetWidth = 320;
                targetFps = 20;
                targetBitrate = 250000;
        }
        
        // Calculate Height keeping aspect ratio
        const aspect = video.videoWidth / video.videoHeight;
        const targetHeight = Math.round(targetWidth / aspect);
        
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        
        // Audio handling
        let combinedStream;
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        try {
            const source = audioCtx.createMediaElementSource(video);
            const dest = audioCtx.createMediaStreamDestination();
            source.connect(dest);
            const videoStream = canvas.captureStream(targetFps);
            combinedStream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
        } catch (e) {
            console.warn("Audio compression setup failed, silent video only.", e);
            combinedStream = canvas.captureStream(targetFps);
        }

        let mimeType = 'video/webm;codecs=vp8,opus';
        if (!MediaRecorder.isTypeSupported(mimeType)) {
             mimeType = 'video/webm'; 
        }
        
        const recorder = new MediaRecorder(combinedStream, {
            mimeType: mimeType,
            videoBitsPerSecond: targetBitrate
        });
        
        const chunks = [];
        recorder.ondataavailable = e => chunks.push(e.data);
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: 'video/webm' });
            compressionPanel.classList.add('hidden');
            
            // Log savings
            const savings = Math.round((1 - (blob.size / file.size)) * 100);
            txStatus.textContent = `Compressed: ${(blob.size/1024).toFixed(1)}KB (${savings}% smaller)`;
            
            // Clean up
            video.remove();
            canvas.remove();
            audioCtx.close();
            resolve(blob);
        };
        
        recorder.start();
        video.play();
        
        compressionStatusText.textContent = `Compressing to ${targetWidth}x${targetHeight} @ ${targetFps}fps...`;
        
        // Drawing Loop
        const draw = () => {
            if (video.paused || video.ended) return;
            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);
            
            // Update Progress
            const pct = (video.currentTime / video.duration) * 100;
            compressionProgress.style.width = `${pct}%`;
            
            requestAnimationFrame(draw);
        };
        
        video.onplay = () => draw();
        video.onended = () => recorder.stop();
        video.onerror = (e) => reject(e);
    });
}

// --- DECODER EVENTS ---

// Tab Switching
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        document.getElementById(`${btn.dataset.tab}-panel`).classList.add('active');
    });
});

btnUploadAudio.addEventListener('click', () => {
    // Reuse context if possible to avoid limit
    if (!modem.ctx) modem.init();
    audioInput.click();
});

audioInput.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    
    const file = e.target.files[0];
    rxStatus.textContent = "Processing audio file (this may take a moment)...";
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        
        // Ensure we have a context
        if (!modem.ctx) modem.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (modem.ctx.state === 'suspended') await modem.ctx.resume();
        
        const audioBuffer = await modem.ctx.decodeAudioData(arrayBuffer);
        
        resetRx();
        
        // Use the selected baud rate from UI
        modem.baud = parseInt(baudSelect.value) || 300;
        console.log(`Decoding at ${modem.baud} baud...`);
        
        modem.decodeOffline(audioBuffer, (byte) => processByte(byte))
            .then(() => {
                if (rxMode === 'DONE') {
                    rxStatus.textContent = "Decoding Successful!";
                } else {
                    console.warn("Decoding finished incomplete.");
                    rxStatus.textContent = "Decoding Finished (Incomplete).";
                    // Try to render what we have if we at least got a header
                    if (rxHeader && rxBuffer.length > 0) {
                        finishDecoding();
                    } else if (rxBuffer.length > 0) {
                        rxStatus.textContent = "Failed: Header not found. Check Baud Rate.";
                    } else {
                        rxStatus.textContent = "Failed: No signal detected.";
                    }
                }
            });
    } catch (err) {
        console.error(err);
        rxStatus.textContent = "Error loading audio file.";
    }
});

btnMic.addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        rxStatus.textContent = "Listening...";
        resetRx();
        
        // Live decoding is EXTREMELY experimental in JS due to timing.
        // We will enable visualizer but warn user.
        alert("Real-time microphone decoding is experimental. For best results, record audio separately and upload it.");
        
        modem.setupReceiver(stream, (byte) => {
            // This path uses the rough real-time approximation
            // processByte(byte); 
        }, (status) => {
            rxStatus.textContent = status;
        });
        
    } catch (err) {
        alert("Microphone access denied.");
    }
});

// --- RX LOGIC ---

function resetRx() {
    rxBuffer = [];
    rxHeader = null;
    rxMode = 'SEARCHING';
    rxStatus.textContent = "Searching for signal...";
    document.getElementById('rx-bytes').textContent = "0 bytes";
    resultArea.classList.add('hidden');
    
    // Clear video
    outputVideo.src = "";
}

function processByte(byte) {
    // console.log("Byte:", byte.toString(16));
    
    if (rxMode === 'SEARCHING') {
        rxBuffer.push(byte);
        // Look for Sync 0xAA 0x55
        if (rxBuffer.length >= 2) {
            const last = rxBuffer[rxBuffer.length-1];
            const prev = rxBuffer[rxBuffer.length-2];
            
            if (prev === 0xAA && last === 0x55) {
                rxMode = 'HEADER';
                rxBuffer = []; // Clear sync bytes
                rxStatus.textContent = "Sync detected! Reading Header...";
            } else if (rxBuffer.length > 10) {
                rxBuffer.shift(); // Keep buffer small
            }
        }
    } else if (rxMode === 'HEADER') {
        rxBuffer.push(byte);
        
        // Header Structure: Size (4) + MimeLen (1)
        if (rxBuffer.length === 5) {
            // We have size and mime len
            const sizeBytes = new Uint8Array(rxBuffer.slice(0, 4));
            // Uint32 from bytes (little endian)
            const size = new Uint32Array(sizeBytes.buffer)[0];
            const mimeLen = rxBuffer[4];
            
            // Sanity Check for invalid headers (noise)
            if (size > 100000000 || mimeLen > 100 || size === 0) { 
                console.warn(`Invalid Header detected: Size=${size}`);
                rxMode = 'SEARCHING';
                rxBuffer = [];
                return;
            }

            rxHeader = { size, mimeLen, mime: '' };
        } 
        
        if (rxHeader && rxBuffer.length === 5 + rxHeader.mimeLen) {
            // We have the mime string
            const mimeBytes = new Uint8Array(rxBuffer.slice(5));
            try {
                const rawMime = new TextDecoder().decode(mimeBytes);
                // Sanitize MIME
                rxHeader.mime = rawMime.replace(/[^a-z0-9\/;\-\.]/gi, '');
                if (rxHeader.mime.length < 3 || !rxHeader.mime.includes('/')) {
                    rxHeader.mime = 'video/mp4'; // Fallback
                }
            } catch(e) {
                rxHeader.mime = 'video/mp4';
            }
            
            rxMode = 'DATA';
            rxBuffer = []; // Reset for payload
            rxStatus.textContent = `Receiving ${rxHeader.mime} (${rxHeader.size} bytes)...`;
        }
    } else if (rxMode === 'DATA') {
        rxBuffer.push(byte);
        
        const pct = Math.floor((rxBuffer.length / rxHeader.size) * 100);
        document.getElementById('rx-progress').style.width = `${pct}%`;
        document.getElementById('rx-bytes').textContent = `${rxBuffer.length} / ${rxHeader.size}`;
        
        if (rxBuffer.length >= rxHeader.size) {
            rxMode = 'DONE';
            finishDecoding();
        }
    }
}

function finishDecoding() {
    rxStatus.textContent = "Reconstructing Video...";
    
    if (rxBuffer.length === 0) {
        rxStatus.textContent = "Error: No data decoded.";
        return;
    }

    try {
        const byteArray = new Uint8Array(rxBuffer);
        const mime = (rxHeader && rxHeader.mime) ? rxHeader.mime : 'video/mp4';
        
        console.log(`Reconstructing Blob: ${byteArray.length} bytes, type: ${mime}`);
        
        const blob = new Blob([byteArray], { type: mime });
        
        if (blob.size === 0) throw new Error("Empty Blob");

        const url = URL.createObjectURL(blob);
        
        outputVideo.onerror = () => {
            rxStatus.textContent = "Video format not supported or corrupted.";
            console.error("Video load error");
        };
        
        outputVideo.src = url;
        outputVideo.load();
        
        downloadVideo.href = url;
        
        let ext = 'mp4';
        if (mime.includes('webm')) ext = 'webm';
        else if (mime.includes('quicktime')) ext = 'mov';
        else if (mime.includes('avi')) ext = 'avi';
        
        downloadVideo.download = `decoded_video.${ext}`;
        
        resultArea.classList.remove('hidden');
        rxStatus.textContent = "Complete!";
    } catch (e) {
        console.error("Reconstruction failed:", e);
        rxStatus.textContent = "Error reconstructing video file.";
    }
}