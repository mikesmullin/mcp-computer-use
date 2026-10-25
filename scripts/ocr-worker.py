#!/usr/bin/env python3
"""Compatibility entrypoint; OCR implementation moved to mcp-vision."""
import runpy
runpy.run_path('/workspace/mcp-vision/scripts/ocr-worker.py', run_name='__main__')
