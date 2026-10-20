Viva 应用图标

viva-source.png：用户确认的扁平版原图，完整保留。
viva.png：1024px 透明圆角通用 PNG。
viva.icns：macOS 应用图标，16–1024px，含 Retina。
viva.ico：Windows 多尺寸图标，16/20/24/32/40/48/64/96/128/256px。
viva.iconset/：macOS 标准图标源集，已加入系统图标边距。
png/：16–1024px 的常用尺寸 PNG。

仅移除与画布边缘连通的外侧黑底，保留猫身、主题色和尾尖花纹。
package.json 中 mac.icon / win.icon 已指向这里的文件。
