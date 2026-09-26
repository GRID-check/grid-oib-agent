# Third-party code in art/riso

`tafeln/index.html` contains code adapted from **riso-windowseat**
(https://github.com/sevenevesai/riso-windowseat, commit `1275fdaf81eb1817b729ee69cbf7b6b6fe535a4e`):

- the print engine from `prints/workings/index.html` and `prints/cabinet/index.html`:
  `mulberry32`, `hash`, `rngFor`, `buildScreen` (with Cabinet's pixel-centred dots),
  the mid-tone `DITHER`, `screenCoverage` (here `screenPlate`), `bakePaper`, `starve`,
  and the bake loop;
- the craft kit: `makeWob`, `tone`, `curve`, `nib`, `print`, `carve`, `shade`, `hatch`,
  `spray`;
- Cabinet's engraved plate numeral, `numeral`.

Changes are listed in the header comment of `tafeln/index.html` and in `tafeln/PRINT.md`.
The drawings themselves (plates, geometry, props) are original to this repository.

The ink colours are real Riso drum colours; their hex values come from the
`riso-colors` list by Matt DesLauriers (MIT). No code from it is included.

The export workflow uses the kit's `tools/still.mjs` from a local clone; no tool code
is copied into this repository.

## riso-windowseat licence

```
MIT License

Copyright (c) 2026 sevenevesai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
