/** 非版权论文内容的三栏/跨栏摘要/首字下沉/竖排下载标记/公式测试 PDF。 */
export function createOCRLayoutFixture() {
  const text = (value, x, y, size = 9) => `BT /F1 ${size} Tf ${x} ${y} Td (${value.replace(/[\\()]/g, '\\$&')}) Tj ET`
  const lines = (values, x, y) => values.map((value, i) => text(value, x, y - 14 * i)).join('\n')
  const streams = [
    [text('Synthetic scientific paper', 40, 760, 20), text('Abstract', 40, 722, 12),
      lines(['A controlled experiment measures optical signals and compares', 'the results across independent instruments. This abstract spans', 'two columns while the body continues in three narrower columns.'], 40, 700),
      text('S', 40, 605, 34), text('mall changes affect signals.', 68, 620),
      lines(['First column begins with the experiment.', 'The instruments collect light from a sample.', 'A reference beam follows a separate path.', 'We compare these signals over time.', 'This measurement uses repeated trials.', 'The observations preserve every signal.', 'The sample remains under stable pressure.', 'All results include uncertainty estimates.'], 40, 590),
      lines(['Second column begins with the analysis.', 'The analysis compares repeated trials.', 'A calibrated instrument checks the result.', 'The measured effect remains consistent.', 'Independent controls exclude background.', 'The method reports the observed values.', 'The sample remains chemically stable.', 'We record all experimental conditions.'], 238, 620),
      lines(['Third column begins with the discussion.', 'The evidence supports the stated result.', 'The method works across several samples.', 'We report uncertainty and limitations.', 'Future studies should test new samples.', 'The final conclusion follows this evidence.', 'All source observations remain available.', 'The experiment can be independently tested.'], 432, 724),
      'BT /F1 7 Tf 0 1 -1 0 625 160 Tm (Downloaded from journal.example by Synthetic User) Tj ET',
      text('600', 300, 20, 8)].join('\n'),
    [text('Equations and results', 40, 750, 18),
      text('The following equations summarize the measurements.', 40, 712),
      ...Array.from({ length: 10 }, (_, i) => text(`y${i} = a${i} x + b${i}`, 240, 670 - i * 35, 14)),
      text('The results retain all observed values and equations.', 40, 240), text('601', 300, 20, 8)].join('\n'),
  ]
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 640 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
  let pdf = '%PDF-1.4\n'; const offsets = []
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
