# Arena3: notes for Claude

Read `AGENTS.md` for the platform contract. Product truth lives in `PRODUCT.md`; the design system (tokens, components, the "Floodlit Hall" direction) in `DESIGN.md`. Where `docs/UI-REDESIGN.md` disagrees with them, `PRODUCT.md` and `DESIGN.md` win. Product direction: English first, Vietnamese second; visual effects and motion take priority over raw performance, as long as they point at something real and honour reduced motion.

## Tooling, one job each

| Job | Tool | How |
|---|---|---|
| Find code | **graft** (`npx graft`) | `ask "<question>" --source`, `grep "<symbol>"`, `skeleton <file>`, `map` |
| Design review and fixes | **Impeccable** skill | `critique`, `audit`, `harden`, `clarify`, `distill`, `quieter`, `layout`, `polish`; `detect --json <files>` once after UI edits |
| Motion | **GSAP** skills + `gsap`, `@gsap/react` | `useGSAP` with cleanup; `gsap.matchMedia()` for reduced motion |
| Web research | **Agent Reach** skill + CLI in `D:\App\agent-reach` | read-only; Exa, Jina, YouTube, V2EX, Bilibili, GitHub |

Typical UI change: (optional) Agent Reach research → Impeccable critique/audit → graft grep/ask to locate → edit → Impeccable detect once + `npx tsc --noEmit` + `npm run build` + screenshots.

## Rules

1. One design lead per task: Impeccable for app screens and reviews. Use the taste skills only when the user asks for them by name.
2. The effect library in `fx.tsx`, `gl.tsx` and `motion.tsx` is the house style, restored at the user's request (see DESIGN.md, "Effect library"). Never remove or flatten it to make a screen calmer; tune strength, opacity or speed instead. New effects must carry meaning (a free hour, a hold countdown, a confirmed payment, the next session), and none go over the court-grid cells. Use `animate`, `delight`, `bolder` freely on the landing.
3. GSAP for landing storytelling and orchestrated moments (timelines, ScrollTrigger); `motion` for in-app transitions. GSAP code lives only in `src/lib/gsap.ts`, `src/components/landing/*` and `src/components/moments/*`, and every scene goes through `useScene()` (or `useGSAP` with `motionOff(calm)`). Never mix GSAP and `motion` in one component. Every animation honours `prefers-reduced-motion` (there is no pause button: main removed it); effects read reduced motion after mount (`useReducedMotionAfterMount`) so hydration matches the server.
4. `graft callers` misses JSX usage (`<CourtGrid>`) and namespace calls (`bookH.bookingsHold`). For blast radius, use `graft grep "<Name"` / `graft grep "name"`.
5. Agent Reach is read-only. Never enter cookies, passwords or tokens for the user; login-based channels are theirs to configure.
6. Run graft with `DO_NOT_TRACK=1`. After `npm ci --ignore-scripts`, run `npm rebuild tree-sitter-kotlin` (needs the VS Build Tools in `D:\App\VSBuildTools`) or graft will not start.
7. Do not change seed data or migrations unless the user asks. Push only to the branch the user names.

## Diagram Generation Standard (STRICT DRAW.IO XML ONLY — NO MERMAID)

Khi tạo bất kỳ sơ đồ nào (Use Case, Class, Sequence, Activity, Context/DFD), LUÔN tạo file `.drawio` hợp lệ trong thư mục `docs/diagrams/` hoặc `docs/drawio/` theo các quy tắc nghiêm ngặt sau:

1. Cấu trúc XML chuẩn Draw.io:
<mxGraphModel dx="1422" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1600" pageHeight="1100" background="#ffffff">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
  </root>
</mxGraphModel>

2. Cấm tuyệt đối:
- Tuyệt đối KHÔNG dùng Mermaid dưới bất kỳ hình thức nào.
- KHÔNG chứa XML comments trong file draw.io xuất ra.
- KHÔNG thiếu mxGeometry trên bất kỳ node hay edge nào.
- Mọi node/khối BẮT BUỘC có vertex="1".
- Mọi đường nối/mũi tên BẮT BUỘC có edge="1".
- ID của các cell phải là duy nhất (unique), không được trùng lặp.
- source và target của edge phải trỏ tới các ID vertex thực sự tồn tại.
- Không để các khối/text chồng chéo lên nhau.

3. Chuẩn UML 2.0 Class Diagram:
- Style:
  style="verticalAlign=top;align=left;overflow=fill;fontSize=12;fontFamily=Helvetica;html=1;whiteSpace=wrap;fillColor=#f8fafc;strokeColor=#475569;"
- Value của class phải dùng thẻ <hr> để chia ngăn rõ ràng:
  <b>ClassName</b><hr>+ attribute1: type<br>- attribute2: type<hr>+ method1(): returnType<br>+ method2(): returnType
- Ký hiệu visibility chuẩn UML: + (public), - (private), # (protected).

4. Quy chuẩn ngôn ngữ và xuất file:
- Toàn bộ nhãn tuân thủ chuẩn tiếng Anh học thuật theo giáo trình SE FPT University.
- Sau khi tạo file, báo đường dẫn file để mở trực tiếp trong draw.io hoặc VS Code extension `hediet.vscode-drawio`.
