# Video Tool (MVP)

Herramienta local para explorar carpetas de video y subtitulos, obtener metadata con ffprobe, extraer/quemar subtitulos con ffmpeg y exponer un API simple + web UI.

## Requisitos
- Node.js 18+
- ffmpeg/ffprobe disponibles en `PATH`
- Definir las carpetas permitidas en `.env` (`ROOTS` separadas por coma)

## Configuracion rapida
1) Edita `.env`:
```
PORT=4000
ROOTS=F:\Oscar\
```
2) Instala deps (ya instaladas si corriste `npm install`):
```
npm install
```
3) Ejecuta el servidor:
```
npm start
```
4) Abre `http://localhost:4000` para la UI estatico, o consume el API.

## Endpoints
- `GET /health` -> verifica servicio y rutas configuradas.
- `GET /browse?path=...` -> lista archivos/carpetas dentro de ROOTS.
- `GET /probe?path=...` -> stats de fs + ffprobe (codec, streams, etc.).
- `POST /extract-subs` -> body `{ input, streamIndex?, output? }` usa ffmpeg `-map 0:s:N`.
- `POST /burn-subs` -> body `{ input, subtitles, output? }` usa filtro `subtitles`/`ass`.
- `POST /file-op` -> body `{ action: copy|move|delete, source, target? }`.
- `POST /translate-subs` -> stub pendiente de integrar LLM; responde mensaje informativo.

Notas:
- Seguridad: solo opera sobre rutas dentro de `ROOTS` (whitelist).
- Extensiones soportadas para deteccion rapida: videos (`mp4,mkv,mov,avi`), subs (`srt,ass,ssa,vtt`).
- La UI actual permite navegar y hacer `probe`. Acciones adicionales se pueden cablear luego.

## Pendientes / ideas siguientes
- Integrar LLM para traduccion por lotes de 100 lineas conservando formato.
- Agregar UI para extraer/quemar subtitulos y operaciones de archivo.
- Streaming de video en navegador con `Content-Range` y reproductor basico.
- Logs y manejo de errores mas detallados.
