/** 阅读器自有浮层的浅深色变量；只匹配插件标记的容器，不改宿主控件或 PDF 页面。 */
export const READER_UI_THEME_CSS = `
[data-jadense-reader-theme] {color:var(--jdx-reader-text,CanvasText);}
[data-jadense-reader-theme][data-theme="light"] {
  color-scheme:light;--jdx-reader-text:#111510;--jdx-reader-muted:#697268;
  --jdx-reader-background:#ffffff;--jdx-reader-surface:#f1f4ef;
  --jdx-reader-hover:rgba(17,21,16,.06);--jdx-reader-active:rgba(17,21,16,.12);
  --jdx-reader-border:rgba(17,21,16,.16);--jdx-reader-line:rgba(17,21,16,.12);--jdx-reader-error:#b42318;
}
[data-jadense-reader-theme][data-theme="dark"] {
  color-scheme:dark;--jdx-reader-text:#f1f5ef;--jdx-reader-muted:#a0ada1;
  --jdx-reader-background:#111611;--jdx-reader-surface:#182019;
  --jdx-reader-hover:rgba(241,245,239,.08);--jdx-reader-active:rgba(241,245,239,.14);
  --jdx-reader-border:rgba(241,245,239,.18);--jdx-reader-line:rgba(241,245,239,.12);--jdx-reader-error:#ef8d85;
}
[data-jadense-reader-theme] [data-reading-budgets]{display:grid;gap:10px;min-width:0}
[data-jadense-reader-theme] .jdx-reading-model-summary,[data-jadense-reader-theme] .jdx-reading-budget-row{display:grid;gap:5px;min-width:0;padding:8px;border:1px solid var(--jdx-reader-line);border-radius:6px;background:var(--jdx-reader-surface)}
[data-jadense-reader-theme] .jdx-reading-model-summary{grid-template-columns:auto minmax(0,1fr);align-items:center}
[data-jadense-reader-theme] .jdx-reading-budget-label{display:block;color:var(--jdx-reader-muted);font-size:11px;line-height:1.3}
[data-jadense-reader-theme] .jdx-reading-model-value{min-width:0;overflow-wrap:anywhere;font-size:12px;font-weight:600}
[data-jadense-reader-theme] .jdx-reading-model-hint{grid-column:1/-1;color:var(--jdx-reader-muted);font-size:11px}
[data-jadense-reader-theme] .jdx-reading-model-hint:empty{display:none}
[data-jadense-reader-theme] .jdx-reading-budget-row{display:block}
[data-jadense-reader-theme] .jdx-reading-budget-row label{display:grid;gap:6px}
[data-jadense-reader-theme] .jdx-reading-budget-row input{background:var(--jdx-reader-background);border:1px solid var(--jdx-reader-border);border-radius:6px;min-height:32px;padding:4px 8px;color:var(--jdx-reader-text)}
[data-jadense-reader-theme] .jdx-reading-budget-row p{margin:6px 0 0;color:var(--jdx-reader-muted);font-size:11px;line-height:1.45}
`
