#!/usr/bin/env python3
"""Crop/resize screenshots and optionally label image pixel coordinates. No perception."""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

source, output, options = sys.argv[1:]
o = json.loads(options)
im = Image.open(source).convert('RGB')
if list(im.size) != [o['sourceWidth'], o['sourceHeight']]:
    raise ValueError('Captured image size differs from client geometry; take another screenshot')
x, y, w, h = (o[k] for k in ('x', 'y', 'width', 'height'))
if min(x, y) < 0 or min(w, h) <= 0 or x+w > im.width or y+h > im.height:
    raise ValueError('Crop is outside screenshot')
im = im.crop((x, y, x+w, y+h))
scale = min(1.0, o['maxWidth']/w)
size = (max(1, round(w*scale)), max(1, round(h*scale)))
if im.size != size:
    im = im.resize(size, Image.Resampling.LANCZOS)
if o['grid']:
    grid = Image.new('RGBA', im.size)
    draw = ImageDraw.Draw(grid)
    font = ImageFont.load_default(size=12)
    for x in range(0, im.width, 100):
        draw.line((x, 0, x, im.height), fill=(255, 255, 255, 80))
        draw.text((x+2, 2), str(x), font=font, fill='white', stroke_width=2, stroke_fill='black')
    for y in range(100, im.height, 100):
        draw.line((0, y, im.width, y), fill=(255, 255, 255, 80))
        draw.text((2, y+2), str(y), font=font, fill='white', stroke_width=2, stroke_fill='black')
    im = Image.alpha_composite(im.convert('RGBA'), grid).convert('RGB')
im.save(output)
print(json.dumps({'width': im.width, 'height': im.height}))
