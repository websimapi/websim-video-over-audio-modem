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
        txStatus.textContent = "Warning: Large file. Transmission will take a long time.";
        txStatus.style.color = "orange";
    } else {
        txStatus.textContent = "Ready to encode.";
        txStatus.style.color = "#aaa";
    }
}

btnPlay.addEventListener('click', async () => {
    if (!selectedFile) return;
    
    btnPlay.disabled = true;
    txStatus.textContent = "Generating audio stream...";
    
    const baud = parseInt(baudSelect.value);
    
    await modem.transmit(selectedFile, baud, (progress) => {
        txProgress.style.width = `${progress * 100}%`;
        txStatus.textContent = `Transmitting: ${Math.floor(progress * 100)}%`;
    }, () => {
        txStatus.textContent = "Transmission Complete.";
        btnPlay.disabled = false;
        txProgress.style.width = '100%';
    });
});

btnDownloadAudio.addEventListener('click', async () => {
    if (!selectedFile) return;
    
    txStatus.textContent = "Rendering audio file (this may freeze briefly)...";
    const baud = parseInt(baudSelect.value);
    
    setTimeout(async () => {
        const blob = await modem.generateDownloadLink(selectedFile, baud);
        if (blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${selectedFile.name}.wav`;
            a.click();
            txStatus.textContent = "Audio saved.";
        }
    }, 100);
});

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

btnUploadAudio.addEventListener('click', () => audioInput.click());

audioInput.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    
    const file = e.target.files[0];
    rxStatus.textContent = "Processing audio file...";
    
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new AudioContext();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    
    resetRx();
    
    modem.baud = 300; // Need to know this or detect it. Assuming 300 default.
    // Try to auto-detect baud? Hard without preamble analysis. 
    // We'll use the user dropdown value as a hint if we could, but here we hardcode 300 for reliability match.
    // Actually, let's use the UI value.
    modem.baud = parseInt(baudSelect.value);
    
    modem.decodeOffline(audioBuffer, (byte) => processByte(byte))
        .then(() => {
            if (rxMode === 'DONE') {
                rxStatus.textContent = "Decoding Successful!";
            } else {
                rxStatus.textContent = "Decoding Finished (Checksum/Truncated?)";
            }
        });
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
            
            rxHeader = { size, mimeLen, mime: '' };
        } 
        
        if (rxHeader && rxBuffer.length === 5 + rxHeader.mimeLen) {
            // We have the mime string
            const mimeBytes = new Uint8Array(rxBuffer.slice(5));
            rxHeader.mime = new TextDecoder().decode(mimeBytes);
            
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
    
    const byteArray = new Uint8Array(rxBuffer);
    const blob = new Blob([byteArray], { type: rxHeader.mime });
    const url = URL.createObjectURL(blob);
    
    outputVideo.src = url;
    downloadVideo.href = url;
    downloadVideo.download = `decoded_video.${rxHeader.mime.split('/')[1]}`;
    
    resultArea.classList.remove('hidden');
    rxStatus.textContent = "Complete!";
}