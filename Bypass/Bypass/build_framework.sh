#!/bin/bash
# build_framework.sh
# Compiles the biometric bypass framework for iOS devices
# Run this script from the Bypass/Bypass directory

set -e

echo "======================================"
echo "Building BiometricBypass Framework"
echo "======================================"

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Configuration
FRAMEWORK_NAME="BiometricBypass"
BUILD_DIR="./build"
FRAMEWORK_DIR="${BUILD_DIR}/${FRAMEWORK_NAME}.framework"
SDK="iphoneos"
ARCHS="arm64"
MIN_IOS_VERSION="17.0"

# Clean previous builds
echo "Cleaning previous builds..."
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"

# Compile source files
echo "Compiling source files..."

for ARCH in ${ARCHS}; do
    echo "Building for architecture: ${ARCH}"

    # Compile BiometricHook.m
    xcrun -sdk ${SDK} clang -arch ${ARCH} \
        -mios-version-min=${MIN_IOS_VERSION} \
        -fobjc-arc \
        -framework Foundation \
        -framework LocalAuthentication \
        -framework Security \
        -c BiometricHook.m \
        -o ${BUILD_DIR}/BiometricHook_${ARCH}.o

    # Compile KeychainHook.m
    xcrun -sdk ${SDK} clang -arch ${ARCH} \
        -mios-version-min=${MIN_IOS_VERSION} \
        -fobjc-arc \
        -framework Foundation \
        -framework Security \
        -c KeychainHook.m \
        -o ${BUILD_DIR}/KeychainHook_${ARCH}.o

    # Compile fishhook.c
    xcrun -sdk ${SDK} clang -arch ${ARCH} \
        -mios-version-min=${MIN_IOS_VERSION} \
        -c fishhook.c \
        -o ${BUILD_DIR}/fishhook_${ARCH}.o

    # Create thin dylib
    xcrun -sdk ${SDK} clang -arch ${ARCH} \
        -dynamiclib \
        -fobjc-arc \
        -mios-version-min=${MIN_IOS_VERSION} \
        -framework Foundation \
        -framework LocalAuthentication \
        -framework Security \
        -install_name "@rpath/${FRAMEWORK_NAME}.framework/${FRAMEWORK_NAME}" \
        ${BUILD_DIR}/BiometricHook_${ARCH}.o \
        ${BUILD_DIR}/KeychainHook_${ARCH}.o \
        ${BUILD_DIR}/fishhook_${ARCH}.o \
        -o ${BUILD_DIR}/${FRAMEWORK_NAME}_${ARCH}.dylib
done

# Create fat binary
echo "Creating universal binary..."
DYLIBS=""
for ARCH in ${ARCHS}; do
    DYLIBS="${DYLIBS} ${BUILD_DIR}/${FRAMEWORK_NAME}_${ARCH}.dylib"
done

xcrun lipo -create ${DYLIBS} -output ${BUILD_DIR}/${FRAMEWORK_NAME}

# Create framework structure
echo "Creating framework structure..."
mkdir -p "${FRAMEWORK_DIR}"
mkdir -p "${FRAMEWORK_DIR}/Headers"

# Copy binary
cp ${BUILD_DIR}/${FRAMEWORK_NAME} "${FRAMEWORK_DIR}/${FRAMEWORK_NAME}"

# Copy headers
cp BiometricHook.h "${FRAMEWORK_DIR}/Headers/"
cp KeychainHook.h "${FRAMEWORK_DIR}/Headers/"
cp fishhook.h "${FRAMEWORK_DIR}/Headers/"

# Create Info.plist
cat > "${FRAMEWORK_DIR}/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>${FRAMEWORK_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>com.devicefarm.${FRAMEWORK_NAME}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>${FRAMEWORK_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>FMWK</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>MinimumOSVersion</key>
    <string>${MIN_IOS_VERSION}</string>
</dict>
</plist>
EOF

# Create module.modulemap
mkdir -p "${FRAMEWORK_DIR}/Modules"
cat > "${FRAMEWORK_DIR}/Modules/module.modulemap" << EOF
framework module ${FRAMEWORK_NAME} {
    umbrella header "BiometricHook.h"
    umbrella header "KeychainHook.h"

    export *
    module * { export * }
}
EOF

# Sign framework (ad-hoc for testing)
echo "Signing framework..."
codesign -f -s - "${FRAMEWORK_DIR}"

# Verify
echo "Verifying framework..."
xcrun lipo -info "${FRAMEWORK_DIR}/${FRAMEWORK_NAME}"
codesign -v "${FRAMEWORK_DIR}"

echo ""
echo "Framework built successfully: ${FRAMEWORK_DIR}"
echo "Architectures: ${ARCHS}"
echo ""

# Copy framework to project root build directory for instrumentor
PROJECT_ROOT_BUILD="../../build"
mkdir -p "${PROJECT_ROOT_BUILD}"
rm -rf "${PROJECT_ROOT_BUILD}/${FRAMEWORK_NAME}.framework"
cp -R "${FRAMEWORK_DIR}" "${PROJECT_ROOT_BUILD}/"
echo "Framework also copied to: ${PROJECT_ROOT_BUILD}/${FRAMEWORK_NAME}.framework"
