Viva application icons / Viva 应用图标

The blue-haired maid (docs/maid-character.md), head and shoulders on a cream rounded square, exported for both platforms by the icon project's own build (app-icon-v1, scripts/build.py there).

viva-source.png: the approved original artwork, preserved unchanged.
viva.png: 1024px transparent rounded PNG.
viva.icns: macOS application icon, 16–1024px including Retina, with the system's outer margin.
viva.ico: Windows multi-resolution icon, 16/20/24/32/40/48/64/96/128/256px, drawn larger to use the whole canvas at small sizes.
viva.iconset/: standard macOS source set.
png/: commonly used PNG sizes from 16 to 1024px.

The tray icons are in src/assets/tray: tray.png / tray@2x.png are the Windows 16 and 32px icons; trayTemplate.png / @2x are the macOS menu-bar template, a silhouette taken from the icon's darker parts (hair and outline). A hand-drawn template would read better at 16px.
package.json mac.icon / win.icon point here.

蓝发女仆（docs/maid-character.zh-CN.md）的头和肩部，放在奶油白圆角方形里，由图标项目自己的脚本导出两个平台的版本（app-icon-v1 里的 scripts/build.py）。

viva-source.png：确认过的原始图稿，完整保留。
viva.png：1024px 透明圆角通用 PNG。
viva.icns：macOS 应用图标，16–1024px，含 Retina，留有系统要求的外边距。
viva.ico：Windows 多尺寸图标，16/20/24/32/40/48/64/96/128/256px；画得更满，小尺寸也用足整个画布。
viva.iconset/：macOS 标准图标源集。
png/：16–1024px 的常用尺寸 PNG。

托盘图标在 src/assets/tray：tray.png / tray@2x.png 是 Windows 的 16 和 32px 图标；trayTemplate.png / @2x 是 macOS 菜单栏的模板图，取图标里较深的部分（头发和轮廓）做成剪影。16px 时手绘的模板图会更清楚。
package.json 中 mac.icon / win.icon 指向这里的文件。
