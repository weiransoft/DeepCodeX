#!/usr/bin/env node
/**
 * 生成 1024x1024 应用图标源图 app-icon.png（仅用 JDK 自带 AWT/ImageIO，零外部依赖）。
 *
 * 设计：垂直蓝渐变圆角方块底 + 白色尖括号 "< >" 与斜杠 "/" 组成代码符号，
 * 语义即 "DeepCode"。产物交 `tauri icon` 生成各平台完整图标集。
 */
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const fs = require("node:fs");

const OUT_DIR = path.join(__dirname, "..", "src-tauri", "icons");
fs.mkdirSync(OUT_DIR, { recursive: true });

const javaSrc = `
import java.awt.*;
import java.awt.geom.*;
import java.awt.image.BufferedImage;
import java.io.File;
import javax.imageio.ImageIO;

public class GenIcon {
    public static void main(String[] args) throws Exception {
        int size = 1024;
        BufferedImage img = new BufferedImage(size, size, BufferedImage.TYPE_INT_ARGB);
        Graphics2D g = img.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);

        // 底：圆角方块 + 垂直蓝渐变
        GradientPaint bg = new GradientPaint(0, 0, new Color(0x2E6BFF), 0, size, new Color(0x1B3FA8));
        g.setPaint(bg);
        g.fill(new RoundRectangle2D.Float(0, 0, size, size, 225, 225));

        g.setColor(Color.WHITE);
        g.setStroke(new BasicStroke(72f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));

        // 左尖括号 "<"
        Path2D left = new Path2D.Float();
        left.moveTo(400, 300);
        left.lineTo(190, 512);
        left.lineTo(400, 724);
        g.draw(left);

        // 右尖括号 ">"
        Path2D right = new Path2D.Float();
        right.moveTo(624, 300);
        right.lineTo(834, 512);
        right.lineTo(624, 724);
        g.draw(right);

        // 中间斜杠 "/"
        g.setStroke(new BasicStroke(60f, BasicStroke.CAP_ROUND, BasicStroke.JOIN_ROUND));
        g.draw(new Line2D.Float(560, 260, 464, 764));

        g.dispose();
        ImageIO.write(img, "png", new File(args[0]));
    }
}
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deepcode-icon-"));
const javaFile = path.join(tmp, "GenIcon.java");
fs.writeFileSync(javaFile, javaSrc);
execSync(`java "${javaFile}" "${path.join(OUT_DIR, "app-icon.png")}"`, { stdio: "inherit" });
console.log("app-icon.png 已生成:", path.join(OUT_DIR, "app-icon.png"));
