# Eagle API reference

Background for the `image-to-eagle` skill. Read this only when the bundled script is not
enough — a new Eagle endpoint is needed, an error must be diagnosed, or something has to be
done by hand. Verified against Eagle 4.0.0 (build 20260401) on macOS.

## Two ways in

| | Native local API | Eagle Skill CLI (MCP) |
| --- | --- | --- |
| Endpoint | `http://127.0.0.1:41595` | `http://127.0.0.1:41596` via `eagle-api-cli.js` |
| Needs the Eagle MCP plugin | no | yes |
| Adding items | instant | can hang in some sandboxes |
| Folder metadata | `folderName`/`parent`, no colors | rich (`iconColor`, `description`) |

The script uses native first and falls back to the CLI. Both calls carry a timeout, so a
hang costs seconds, not the whole turn.

Native API may require a token in some setups (Eagle preferences → developer). Pass it via
`EAGLE_API_TOKEN`; the script appends it as `?token=`.

## Native endpoints used

```text
GET  /api/application/info                       reachability + version
GET  /api/folder/list                            full tree; parent comes from nesting only
POST /api/folder/create   {folderName, parent}
POST /api/item/addFromPath {path, name, annotation, tags, folderId}   -> data = item id
POST /api/item/addFromURL  {url,  name, annotation, tags, folderId}
POST /api/item/update      {id, tags, annotation, url, star}
GET  /api/item/list?limit=500&folders=<id>       used for the duplicate check
```

Success responses are `{"status":"success","data":…}`; failures use `"status":"error"`.

## Eagle Skill CLI

```text
~/Library/Application Support/Eagle/Plugins/mcp-server/skills/eagle-skill/scripts/eagle-api-cli.js
```

On Windows it lives under `%APPDATA%\Eagle\…`, on Linux under `~/.config/Eagle/…`.
Override with `EAGLE_SKILL_CLI`.

```bash
node "$EAGLE_CLI" list                       # all tools
node "$EAGLE_CLI" help <tool>                # one tool's schema
node "$EAGLE_CLI" call <tool> --json '<params>'
```

Responses are `{"success":true,"data":…}`. Notable parameter shapes:

```bash
# Folder tree. `parent` is present here (unlike the native API) but children still nest.
node "$EAGLE_CLI" call folder_get --json '{"getAllHierarchy":true,"fullDetails":true}'

# Create a folder. Omit parentId for a root folder.
node "$EAGLE_CLI" call folder_create --json '{"parentId":"ROOT_ID","folders":[{"name":"2026-08-27","parentId":"ROOT_ID","iconColor":"aqua"}]}'

# Add an item. `source.type` is "path" or "url"; folders/annotation are per item.
node "$EAGLE_CLI" call item_add --json '{"tags":["AI生成"],"items":[{"name":"NAME","annotation":"TEXT","folders":["FOLDER_ID"],"source":{"type":"path","path":"/abs/img.png"}}]}'

# Trash items. The parameter is `ids`, not `itemIds`.
node "$EAGLE_CLI" call item_move_to_trash --json '{"ids":["ITEM_ID"]}'
```

Further tool docs ship with Eagle:
`…/skills/eagle-skill/references/{item,folder,tag,smart-folder}-tools.md`.

## Folder resolution rules

Duplicate folder names are the main failure mode, so the script follows fixed rules:

1. Match on exact `name` **and** exact parent ID. Never search a date name globally — many
   roots can hold a `2026-08-27`.
2. Neither API returns a usable `parent` for every build, so derive the parent from the
   nesting when the field is missing.
3. Create under a `mkdir`-based lock in `os.tmpdir()`, so concurrent jobs cannot create two
   date folders. A lock older than twice the timeout is treated as stale.
4. Re-list after creating and resolve the new ID; folder-create responses are not uniform
   across transports.
5. If several folders already share a name and parent, reuse the **oldest** and warn.

## Environment variables

```text
EAGLE_API_URL                 native base URL       default http://127.0.0.1:41595
EAGLE_API_TOKEN               native API token      default none
EAGLE_SERVER_URL              MCP base URL          default http://127.0.0.1:41596
EAGLE_SKILL_CLI               path to eagle-api-cli.js
EAGLE_IMAGE_ROOT_FOLDER       root folder name      default "AI 生成图"
EAGLE_IMAGE_ROOT_FOLDER_ID    skip root lookup, still uses date subfolders
EAGLE_IMAGE_FOLDER_ID         fixed destination, no date subfolder
EAGLE_DATE_TZ                 IANA zone for the date folder; default system local time
EAGLE_TIMEOUT_MS              per-request timeout   default 15000
EAGLE_FOLDER_LOCK_TIMEOUT_MS  lock wait            default 15000
```

## Manual fallback

If the script itself is unavailable, one image can be archived with plain Node:

```bash
node -e '
const http=require("http");
const body=JSON.stringify({path:"/abs/img.png",name:"NAME",annotation:"Prompt:\nTEXT",tags:["AI生成"],folderId:"FOLDER_ID"});
const req=http.request({hostname:"127.0.0.1",port:41595,path:"/api/item/addFromPath",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)},timeout:10000},r=>{let d="";r.on("data",c=>d+=c);r.on("end",()=>console.log(d))});
req.on("timeout",()=>{req.destroy();console.log("timeout")});
req.end(body);'
```
