/**
 * 生成第三方许可证文档脚本
 * 输出格式：JSON + TXT + CSV
 */

const checker = require('license-checker');
const fs = require('fs');
const path = require('path');

const outputDir = path.join(__dirname, '..', 'licenses');

// 确保输出目录存在
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('正在扫描依赖许可证信息...\n');

checker.init(
  {
    start: path.join(__dirname, '..'),
    production: true,
    customPath: path.join(__dirname, 'format.json'),
  },
  (err, packages) => {
    if (err) {
      console.error('扫描失败:', err);
      process.exit(1);
    }

    // 排除当前项目本身
    const packageName = require('../package.json').name;
    const filteredPackages = {};
    for (const [key, value] of Object.entries(packages)) {
      // 排除格式为 "包名@版本号" 的当前项目条目
      if (!key.startsWith(packageName + '@')) {
        filteredPackages[key] = value;
      }
    }

    const packageCount = Object.keys(filteredPackages).length;
    console.log(`发现 ${packageCount} 个第三方依赖包\n`);

    // 生成 JSON 格式
    const jsonPath = path.join(outputDir, 'licenses.json');
    fs.writeFileSync(jsonPath, JSON.stringify(filteredPackages, null, 2));
    console.log(`已生成: ${jsonPath}`);

    // 生成 TXT 格式（适合阅读）
    const txtPath = path.join(outputDir, 'THIRD_PARTY_LICENSES.txt');
    let txtContent = '第三方开源组件许可证声明\n';
    txtContent += '='.repeat(80) + '\n';
    txtContent += `生成时间: ${new Date().toISOString()}\n`;
    txtContent += `依赖总数: ${packageCount}\n`;
    txtContent += '='.repeat(80) + '\n\n';

    const sortedPackages = Object.keys(filteredPackages).sort();
    for (const pkg of sortedPackages) {
      const info = filteredPackages[pkg];
      txtContent += '-'.repeat(80) + '\n';
      txtContent += `组件: ${pkg}\n`;
      txtContent += `版本: ${info.version || '未知'}\n`;
      txtContent += `许可证: ${info.licenses || '未知'}\n`;
      if (info.repository) {
        txtContent += `仓库: ${info.repository}\n`;
      }
      if (info.publisher) {
        txtContent += `作者: ${info.publisher}\n`;
      }
      if (info.licenseText) {
        txtContent += '\n许可证全文:\n';
        txtContent += info.licenseText + '\n';
      }
      txtContent += '\n';
    }

    fs.writeFileSync(txtPath, txtContent);
    console.log(`已生成: ${txtPath}`);

    // 生成 CSV 格式（适合表格展示）
    const csvPath = path.join(outputDir, 'licenses.csv');
    let csvContent = '组件,版本,许可证,仓库,作者\n';
    for (const pkg of sortedPackages) {
      const info = filteredPackages[pkg];
      const fields = [
        pkg,
        info.version || '',
        info.licenses || '',
        info.repository || '',
        info.publisher || '',
      ].map((f) => `"${(f || '').replace(/"/g, '""')}"`);
      csvContent += fields.join(',') + '\n';
    }

    fs.writeFileSync(csvPath, csvContent);
    console.log(`已生成: ${csvPath}`);

    // 生成许可证摘要
    const licenseTypes = {};
    for (const pkg of sortedPackages) {
      const licenses = filteredPackages[pkg].licenses || '未知';
      licenses.split(',').forEach((l) => {
        const license = l.trim();
        if (!licenseTypes[license]) {
          licenseTypes[license] = [];
        }
        licenseTypes[license].push(pkg);
      });
    }

    const summaryPath = path.join(outputDir, 'LICENSE_SUMMARY.md');
    let summaryContent = '# 第三方许可证摘要\n\n';
    summaryContent += `生成时间: ${new Date().toISOString()}\n\n`;
    summaryContent += '## 许可证类型统计\n\n';
    summaryContent += '| 许可证 | 数量 | 组件 |\n';
    summaryContent += '|--------|------|------|\n';

    for (const [license, pkgs] of Object.entries(licenseTypes).sort()) {
      summaryContent += `| ${license} | ${pkgs.length} | ${pkgs.slice(0, 3).join(', ')}${pkgs.length > 3 ? '...' : ''} |\n`;
    }

    fs.writeFileSync(summaryPath, summaryContent);
    console.log(`已生成: ${summaryPath}`);

    console.log('\n完成！');
  }
);
