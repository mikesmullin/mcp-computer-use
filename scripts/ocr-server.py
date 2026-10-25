#!/usr/bin/env python3
"""Compatibility entrypoint; OCR service moved to mcp-vision."""
import runpy
runpy.run_path('/workspace/mcp-vision/scripts/ocr-server.py', run_name='__main__')
