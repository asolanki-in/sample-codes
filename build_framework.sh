#!/bin/bash
# build_framework.sh
# Wrapper script that calls the actual build script in the Bypass/Bypass directory

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/Bypass/Bypass"

# Make the build script executable and run it
chmod +x build_framework.sh
./build_framework.sh
