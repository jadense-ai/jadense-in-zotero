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
`
