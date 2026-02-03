# api_server.py
# Production-ready Flask API server for device farm management

from flask import Flask, request, jsonify, send_file, render_template_string
from flask_cors import CORS
from pathlib import Path
import threading
import queue
import subprocess
import time
import uuid
import json
from instrumentor import IPAInstrumentor
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

UPLOAD_FOLDER = Path("./uploads")
OUTPUT_FOLDER = Path("./instrumented")
UPLOAD_FOLDER.mkdir(exist_ok=True)
OUTPUT_FOLDER.mkdir(exist_ok=True)

job_queue = queue.Queue()
jobs = {}

class DeviceFarmManager:
    def __init__(self):
        self.devices = {}
        self.refresh_devices()
        
    def refresh_devices(self):
        """Detect all connected iOS devices"""
        try:
            result = subprocess.run(['idevice_id', '-l'],
                                  capture_output=True, text=True, timeout=5)
            device_ids = [udid.strip() for udid in result.stdout.strip().split('\n') if udid.strip()]
            
            current_devices = {}
            for udid in device_ids:
                device_info = self.get_device_info(udid)
                current_devices[udid] = device_info
            
            self.devices = current_devices
            logger.info(f"Detected {len(self.devices)} device(s)")
            return list(self.devices.values())
            
        except subprocess.TimeoutExpired:
            logger.error("Device detection timed out")
            return []
        except Exception as e:
            logger.error(f"Error detecting devices: {e}")
            return []
    
    def get_device_info(self, udid):
        """Get detailed information about a device"""
        try:
            name = subprocess.run(['ideviceinfo', '-u', udid, '-k', 'DeviceName'],
                                capture_output=True, text=True, timeout=5).stdout.strip()
            
            product_version = subprocess.run(['ideviceinfo', '-u', udid, '-k', 'ProductVersion'],
                                           capture_output=True, text=True, timeout=5).stdout.strip()
            
            product_type = subprocess.run(['ideviceinfo', '-u', udid, '-k', 'ProductType'],
                                        capture_output=True, text=True, timeout=5).stdout.strip()
            
            return {
                'udid': udid,
                'name': name or 'Unknown Device',
                'ios_version': product_version or 'Unknown',
                'model': product_type or 'Unknown',
                'status': 'available'
            }
        except:
            return {
                'udid': udid,
                'name': 'Unknown Device',
                'ios_version': 'Unknown',
                'model': 'Unknown',
                'status': 'available'
            }
    
    def install_ipa(self, udid, ipa_path):
        """Install IPA on specified device"""
        try:
            logger.info(f"Installing {ipa_path} on device {udid}")
            result = subprocess.run(['ideviceinstaller', '-u', udid, '-i', str(ipa_path)],
                                  capture_output=True, text=True, timeout=120)
            
            if result.returncode == 0:
                logger.info(f"Successfully installed on {udid}")
                return True
            else:
                logger.error(f"Installation failed: {result.stderr}")
                return False
                
        except subprocess.TimeoutExpired:
            logger.error("Installation timed out")
            return False
        except Exception as e:
            logger.error(f"Error installing IPA: {e}")
            return False
    
    def launch_app(self, udid, bundle_id):
        """Launch app on device"""
        try:
            logger.info(f"Launching {bundle_id} on device {udid}")
            subprocess.run(['idevicedebug', 'run', bundle_id, '-u', udid],
                         capture_output=True, timeout=10)
            return True
        except Exception as e:
            logger.error(f"Error launching app: {e}")
            return False

farm = DeviceFarmManager()

def instrument_worker():
    """Background worker for processing instrumentation jobs"""
    while True:
        try:
            job_id, ipa_path, output_path, signing_identity = job_queue.get(timeout=1)
            
            jobs[job_id]['status'] = 'processing'
            jobs[job_id]['progress'] = 'Starting instrumentation...'
            
            try:
                instrumentor = IPAInstrumentor(ipa_path, output_path)
                
                jobs[job_id]['progress'] = 'Extracting IPA...'
                instrumentor.extract_ipa()
                
                jobs[job_id]['progress'] = 'Analyzing binary...'
                instrumentor.find_binary()
                instrumentor.analyze_binary()
                
                jobs[job_id]['progress'] = 'Injecting BiometricBypass framework...'
                instrumentor.inject_framework()
                
                jobs[job_id]['progress'] = 'Re-signing application...'
                instrumentor.resign_app(signing_identity)
                
                jobs[job_id]['progress'] = 'Repacking IPA...'
                instrumentor.repack_ipa()
                
                jobs[job_id]['progress'] = 'Cleaning up...'
                instrumentor.cleanup()
                
                jobs[job_id]['status'] = 'completed'
                jobs[job_id]['output_path'] = str(output_path)
                jobs[job_id]['bundle_id'] = instrumentor.bundle_id
                jobs[job_id]['progress'] = 'Instrumentation complete'
                
                logger.info(f"Job {job_id} completed successfully")
                
            except Exception as e:
                jobs[job_id]['status'] = 'failed'
                jobs[job_id]['error'] = str(e)
                jobs[job_id]['progress'] = f'Failed: {str(e)}'
                logger.error(f"Job {job_id} failed: {e}")
            
            job_queue.task_done()
            
        except queue.Empty:
            continue
        except Exception as e:
            logger.error(f"Worker error: {e}")

worker_thread = threading.Thread(target=instrument_worker, daemon=True)
worker_thread.start()

HTML_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <title>iOS Biometric Bypass Device Farm</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 10px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }
        .header h1 { font-size: 28px; margin-bottom: 10px; }
        .header p { opacity: 0.9; }
        .content { padding: 30px; }
        .section {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 25px;
            margin-bottom: 20px;
        }
        .section h2 {
            font-size: 20px;
            margin-bottom: 15px;
            color: #333;
        }
        .upload-area {
            border: 3px dashed #667eea;
            border-radius: 8px;
            padding: 40px;
            text-align: center;
            cursor: pointer;
            transition: all 0.3s;
        }
        .upload-area:hover {
            background: #f0f0ff;
            border-color: #764ba2;
        }
        .upload-area.dragover {
            background: #e8e8ff;
            border-color: #764ba2;
        }
        input[type="file"] { display: none; }
        .btn {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 12px 30px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 16px;
            transition: transform 0.2s;
        }
        .btn:hover { transform: translateY(-2px); }
        .btn:disabled {
            background: #ccc;
            cursor: not-allowed;
        }
        .device-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
        }
        .device-card {
            background: white;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            transition: all 0.3s;
        }
        .device-card:hover {
            border-color: #667eea;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.2);
        }
        .device-name { font-weight: bold; margin-bottom: 5px; }
        .device-info { font-size: 14px; color: #666; }
        .status {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            margin-top: 10px;
        }
        .status.available { background: #d4edda; color: #155724; }
        .status.processing { background: #fff3cd; color: #856404; }
        .status.completed { background: #d4edda; color: #155724; }
        .status.failed { background: #f8d7da; color: #721c24; }
        .progress-bar {
            background: #e0e0e0;
            border-radius: 10px;
            height: 8px;
            overflow: hidden;
            margin: 10px 0;
        }
        .progress-fill {
            background: linear-gradient(90deg, #667eea 0%, #764ba2 100%);
            height: 100%;
            transition: width 0.3s;
        }
        .job-card {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 15px;
            border: 2px solid #e0e0e0;
        }
        .job-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        .job-title {
            font-weight: bold;
            font-size: 16px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🔐 iOS Biometric Bypass Device Farm</h1>
            <p>Professional biometric and Keychain bypass testing</p>
        </div>
        <div class="content">
            <div class="section">
                <h2>📱 Connected Devices (<span id="device-count">0</span>)</h2>
                <div class="device-grid" id="devices"></div>
                <button class="btn" onclick="refreshDevices()" style="margin-top: 15px;">🔄 Refresh Devices</button>
            </div>
            
            <div class="section">
                <h2>📤 Upload IPA for Instrumentation</h2>
                <div class="upload-area" id="uploadArea">
                    <div style="font-size: 48px; margin-bottom: 10px;">📦</div>
                    <p style="font-size: 18px; margin-bottom: 10px;">Drop IPA file here or click to browse</p>
                    <p style="color: #666;">Supported: .ipa files</p>
                    <input type="file" id="fileInput" accept=".ipa">
                </div>
                <div id="uploadStatus" style="margin-top: 15px;"></div>
            </div>
            
            <div class="section">
                <h2>⚙️ Instrumentation Jobs</h2>
                <div id="jobs"></div>
            </div>
        </div>
    </div>
    
    <script>
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('fileInput');
        
        uploadArea.onclick = () => fileInput.click();
        
        uploadArea.ondragover = (e) => {
            e.preventDefault();
            uploadArea.classList.add('dragover');
        };
        
        uploadArea.ondragleave = () => uploadArea.classList.remove('dragover');
        
        uploadArea.ondrop = (e) => {
            e.preventDefault();
            uploadArea.classList.remove('dragover');
            const file = e.dataTransfer.files[0];
            if (file && file.name.endsWith('.ipa')) {
                uploadFile(file);
            }
        };
        
        fileInput.onchange = (e) => {
            const file = e.target.files[0];
            if (file) uploadFile(file);
        };
        
        async function uploadFile(file) {
            const formData = new FormData();
            formData.append('file', file);
            
            document.getElementById('uploadStatus').innerHTML = '<p>⏳ Uploading...</p>';
            
            try {
                const response = await fetch('/api/upload', {
                    method: 'POST',
                    body: formData
                });
                
                const data = await response.json();
                if (data.job_id) {
                    document.getElementById('uploadStatus').innerHTML = '<p style="color: green;">✅ Upload successful! Job ID: ' + data.job_id + '</p>';
                    monitorJob(data.job_id);
                } else {
                    document.getElementById('uploadStatus').innerHTML = '<p style="color: red;">❌ Upload failed</p>';
                }
            } catch (error) {
                document.getElementById('uploadStatus').innerHTML = '<p style="color: red;">❌ Error: ' + error + '</p>';
            }
        }
        
        async function refreshDevices() {
            try {
                const response = await fetch('/api/devices');
                const data = await response.json();
                const devicesDiv = document.getElementById('devices');
                document.getElementById('device-count').textContent = data.devices.length;
                
                if (data.devices.length === 0) {
                    devicesDiv.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No devices detected. Connect devices via USB.</p>';
                } else {
                    devicesDiv.innerHTML = data.devices.map(device => `
                        <div class="device-card">
                            <div class="device-name">${device.name}</div>
                            <div class="device-info">iOS ${device.ios_version}</div>
                            <div class="device-info">${device.model}</div>
                            <div class="device-info" style="font-size: 11px; color: #999; margin-top: 5px;">${device.udid.substring(0, 16)}...</div>
                            <span class="status available">${device.status}</span>
                        </div>
                    `).join('');
                }
            } catch (error) {
                console.error('Error refreshing devices:', error);
            }
        }
        
        async function monitorJob(jobId) {
            const interval = setInterval(async () => {
                try {
                    const response = await fetch('/api/jobs/' + jobId);
                    const job = await response.json();
                    updateJobDisplay(job, jobId);
                    
                    if (job.status === 'completed' || job.status === 'failed') {
                        clearInterval(interval);
                    }
                } catch (error) {
                    console.error('Error monitoring job:', error);
                }
            }, 1000);
        }
        
        function updateJobDisplay(job, jobId) {
            const jobsDiv = document.getElementById('jobs');
            const existing = document.getElementById('job-' + jobId);
            
            const html = `
                <div id="job-${jobId}" class="job-card">
                    <div class="job-header">
                        <div>
                            <span class="job-title">Job ${jobId}</span>
                            <span class="status ${job.status}">${job.status}</span>
                        </div>
                        ${job.status === 'completed' ? `
                            <button class="btn" onclick="downloadIPA('${jobId}')">⬇️ Download</button>
                        ` : ''}
                    </div>
                    <div style="margin-top: 10px; color: #666;">${job.progress}</div>
                    ${job.status === 'processing' ? '<div class="progress-bar"><div class="progress-fill" style="width: 50%;"></div></div>' : ''}
                    ${job.bundle_id ? `<div style="margin-top: 8px; font-size: 13px; color: #999;">Bundle ID: ${job.bundle_id}</div>` : ''}
                    ${job.error ? `<div style="margin-top: 8px; color: #d32f2f; font-size: 13px;">Error: ${job.error}</div>` : ''}
                </div>
            `;
            
            if (existing) {
                existing.outerHTML = html;
            } else {
                jobsDiv.insertAdjacentHTML('afterbegin', html);
            }
        }
        
        function downloadIPA(jobId) {
            window.location.href = '/api/download/' + jobId;
        }
        
        refreshDevices();
        setInterval(refreshDevices, 10000);
    </script>
</body>
</html>
"""

@app.route('/')
def index():
    """Serve web interface"""
    return render_template_string(HTML_TEMPLATE)

@app.route('/api/devices', methods=['GET'])
def list_devices():
    """List connected iOS devices"""
    devices = farm.refresh_devices()
    return jsonify({'devices': devices})

@app.route('/api/upload', methods=['POST'])
def upload_ipa():
    """Upload IPA file for instrumentation"""
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if not file.filename or not file.filename.endswith('.ipa'):
        return jsonify({'error': 'File must be .ipa'}), 400
    
    job_id = str(uuid.uuid4())[:8]
    filename = Path(file.filename).name
    ipa_path = UPLOAD_FOLDER / f"{job_id}_{filename}"
    output_path = OUTPUT_FOLDER / f"{job_id}_instrumented.ipa"
    
    file.save(ipa_path)
    
    signing_identity = request.form.get('signing_identity', None)
    
    jobs[job_id] = {
        'status': 'queued',
        'ipa_path': str(ipa_path),
        'output_path': str(output_path),
        'progress': '⏳ Waiting in queue...',
        'created_at': time.time()
    }
    
    job_queue.put((job_id, ipa_path, output_path, signing_identity))
    
    return jsonify({'job_id': job_id, 'status': 'queued'})

@app.route('/api/jobs/<job_id>', methods=['GET'])
def get_job_status(job_id):
    """Get job status"""
    if job_id not in jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    return jsonify(jobs[job_id])

@app.route('/api/download/<job_id>', methods=['GET'])
def download_instrumented(job_id):
    """Download instrumented IPA"""
    if job_id not in jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    job = jobs[job_id]
    if job['status'] != 'completed':
        return jsonify({'error': 'Job not completed'}), 400
    
    return send_file(job['output_path'], as_attachment=True)

@app.route('/api/install', methods=['POST'])
def install_on_device():
    """Install instrumented IPA on device"""
    data = request.json
    
    if 'job_id' not in data or 'udid' not in data:
        return jsonify({'error': 'Missing job_id or udid'}), 400
    
    job_id = data['job_id']
    udid = data['udid']
    
    if job_id not in jobs:
        return jsonify({'error': 'Job not found'}), 404
    
    job = jobs[job_id]
    if job['status'] != 'completed':
        return jsonify({'error': 'Job not completed'}), 400
    
    success = farm.install_ipa(udid, job['output_path'])
    
    if success:
        if 'bundle_id' in job:
            farm.launch_app(udid, job['bundle_id'])
        return jsonify({'success': True, 'message': 'IPA installed and launched successfully'})
    else:
        return jsonify({'error': 'Installation failed'}), 500

if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='iOS Biometric Bypass Device Farm Server')
    parser.add_argument('--port', type=int, default=5001, help='Port to run server on (default: 5001)')
    args = parser.parse_args()

    print("\n" + "="*60)
    print("iOS Biometric Bypass Device Farm Server")
    print("="*60)
    print(f"\nConnected Devices: {len(farm.devices)}")
    for device in farm.devices.values():
        print(f"   - {device['name']} (iOS {device['ios_version']}) - {device['udid'][:16]}...")
    print(f"\nServer running on http://localhost:{args.port}")
    print("="*60 + "\n")

    app.run(host='0.0.0.0', port=args.port, debug=False, threaded=True)
