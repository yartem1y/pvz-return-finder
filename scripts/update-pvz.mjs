import { appendFile, readFile, writeFile } from 'node:fs/promises';

const CONFIG = Object.freeze({
  pointsRange: "'Данные пунктов выдачи 2'!A:G",
  citiesRange: "'Города без ПВЗ'!A:A",
  outputPath: 'pvz.json',
  allowedTypes: new Set(['magnit_store', 'partner_pvz', 'yandex_pvz']),
  pointHeaders: ['code', 'address', 'latitude', 'longitude', 'city', 'is_active', 'type'],
  minimumPointCount: 1_000,
  maximumPointDropRatio: 0.5,
  maximumActiveDropRatio: 0.5,
});

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeKey(value) {
  return cleanText(value).toLocaleLowerCase('ru').replace(/ё/g, 'е');
}

function parseNumber(value) {
  if (typeof value === 'number') return value;
  const normalized = cleanText(value).replace(/\s/g, '').replace(',', '.');
  return normalized ? Number(normalized) : Number.NaN;
}

function parseBoolean(value) {
  if (value === true || value === false) return value;
  const normalized = normalizeKey(value);
  if (['true', 'истина'].includes(normalized)) return true;
  if (['false', 'ложь'].includes(normalized)) return false;
  return null;
}

function codeMatchesType(code, type) {
  if (type === 'magnit_store') return /^.+%.+$/.test(code);
  if (type === 'partner_pvz') return /^.+-.+$/.test(code);
  if (type === 'yandex_pvz') return /^.+\^.+$/.test(code);
  return false;
}

function readCities(rows) {
  const header = normalizeKey(rows[0]?.[0]);
  if (header !== 'город') {
    throw new Error(`На листе "Города без ПВЗ" в A1 ожидался заголовок "Город", получено "${cleanText(rows[0]?.[0]) || 'пусто'}".`);
  }

  const cities = [];
  const seen = new Set();
  const warnings = [];

  rows.slice(1).forEach((row, index) => {
    const city = cleanText(row[0]);
    if (!city) return;
    const key = normalizeKey(city);
    if (seen.has(key)) {
      warnings.push(`Лист "Города без ПВЗ", строка ${index + 2}: город "${city}" указан повторно.`);
      return;
    }
    seen.add(key);
    cities.push(city);
  });

  return { cities, cityKeys: seen, warnings };
}

function readPoints(rows, cityKeys) {
  const headers = (rows[0] || []).map(normalizeKey);
  const missingHeaders = CONFIG.pointHeaders.filter(header => !headers.includes(header));
  if (missingHeaders.length) {
    throw new Error(`На листе "Данные пунктов выдачи 2" не найдены колонки: ${missingHeaders.join(', ')}.`);
  }

  const column = Object.fromEntries(CONFIG.pointHeaders.map(header => [header, headers.indexOf(header)]));
  const points = [];
  const errors = [];
  const warnings = [];
  const codeRows = new Map();
  let unknownPointCount = 0;
  let unsupportedCodeCount = 0;
  let skippedRowCount = 0;

  rows.slice(1).forEach((row, index) => {
    const sheetRow = index + 2;
    const code = cleanText(row[column.code]);
    const address = cleanText(row[column.address]);
    const city = cleanText(row[column.city]);
    const type = normalizeKey(row[column.type]);
    const latitudeValue = row[column.latitude];
    const longitudeValue = row[column.longitude];
    const isActiveValue = row[column.is_active];
    const hasAnyData = [code, address, city, type, latitudeValue, longitudeValue, isActiveValue]
      .some(value => cleanText(value));

    if (!hasAnyData) return;
    if (type === 'unknown') {
      unknownPointCount += 1;
      return;
    }
    if (type === 'partner_pvz' && !codeMatchesType(code, type) && (/^-/.test(code) || /-$/.test(code))) {
      unsupportedCodeCount += 1;
      return;
    }

    const rowErrors = [];
    if (!code) rowErrors.push(`Строка ${sheetRow}: не заполнен code.`);
    if (!address) rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: не заполнен address.`);
    if (!city) rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: не заполнен city.`);

    const latitude = parseNumber(latitudeValue);
    const longitude = parseNumber(longitudeValue);
    const isActive = parseBoolean(isActiveValue);

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: некорректная latitude.`);
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: некорректная longitude.`);
    }
    if (isActive === null) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: is_active должен быть TRUE или FALSE.`);
    }
    if (!CONFIG.allowedTypes.has(type)) {
      rowErrors.push(`Строка ${sheetRow}, ${code || 'без code'}: неизвестный type "${type || 'пусто'}".`);
    } else if (!codeMatchesType(code, type)) {
      rowErrors.push(`Строка ${sheetRow}, ${code}: code не соответствует type "${type}".`);
    }

    if (code) {
      const codeKey = normalizeKey(code);
      if (codeRows.has(codeKey)) {
        rowErrors.push(`Строка ${sheetRow}, ${code}: code уже используется в строке ${codeRows.get(codeKey)}.`);
      }
    }

    if (isActive === true && type === 'yandex_pvz') {
      rowErrors.push(`Строка ${sheetRow}, ${code}: yandex_pvz не может быть активным.`);
    }
    if (isActive === true && cityKeys.has(normalizeKey(city))) {
      rowErrors.push(`Строка ${sheetRow}, ${code}: активная точка находится в городе без ПВЗ "${city}".`);
    }
    if (/^заменить$/i.test(address)) {
      warnings.push(`Строка ${sheetRow}, ${code}: в address указано "Заменить".`);
    }

    if (rowErrors.length) {
      skippedRowCount += 1;
      errors.push(...rowErrors);
      return;
    }

    codeRows.set(normalizeKey(code), sheetRow);
    points.push({ code, address, latitude, longitude, city, is_active: isActive, type });
  });

  return { points, errors, warnings, unknownPointCount, unsupportedCodeCount, skippedRowCount };
}

async function fetchSheetRanges(spreadsheetId, accessToken) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`);
  url.searchParams.append('ranges', CONFIG.pointsRange);
  url.searchParams.append('ranges', CONFIG.citiesRange);
  url.searchParams.set('majorDimension', 'ROWS');
  url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Google Sheets API вернул ${response.status}: ${body.slice(0, 500)}`);
  }

  const result = await response.json();
  if (!Array.isArray(result.valueRanges) || result.valueRanges.length !== 2) {
    throw new Error('Google Sheets API не вернул оба ожидаемых диапазона.');
  }
  return result.valueRanges.map(range => range.values || []);
}

function comparablePayload(payload) {
  return {
    schema_version: payload.schema_version,
    cities_without_pvz: payload.cities_without_pvz,
    points: payload.points,
  };
}

function assertSafeChange(currentPayload, nextPayload) {
  const nextPointCount = nextPayload.points.length;
  if (nextPointCount < CONFIG.minimumPointCount) {
    throw new Error(`Получено только ${nextPointCount} точек. Автоматическое обновление заблокировано.`);
  }
  if (!currentPayload?.points?.length) return;

  const currentPointCount = currentPayload.points.length;
  const pointDropRatio = (currentPointCount - nextPointCount) / currentPointCount;
  if (pointDropRatio > CONFIG.maximumPointDropRatio) {
    throw new Error(`Количество точек уменьшилось с ${currentPointCount} до ${nextPointCount} более чем на 50%.`);
  }

  const currentActiveCount = currentPayload.points.filter(point => point.is_active === true).length;
  const nextActiveCount = nextPayload.points.filter(point => point.is_active === true).length;
  if (currentActiveCount > 0) {
    const activeDropRatio = (currentActiveCount - nextActiveCount) / currentActiveCount;
    if (activeDropRatio > CONFIG.maximumActiveDropRatio) {
      throw new Error(`Количество активных точек уменьшилось с ${currentActiveCount} до ${nextActiveCount} более чем на 50%.`);
    }
  }
}

function escapeWorkflowCommand(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function buildMarkdownSummary(report) {
  const statusLabel = report.status === 'success' ? 'Успешно' : 'Ошибка';
  const lines = [
    '# Обновление данных ПВЗ',
    '',
    `**Статус:** ${statusLabel}`,
    `**Этап:** ${report.stage}`,
    `**Начало:** ${report.started_at}`,
    `**Завершение:** ${report.finished_at}`,
    '',
  ];

  if (report.metrics) {
    lines.push(
      '## Результат',
      '',
      '| Показатель | Значение |',
      '|---|---:|',
      `| Точек в JSON | ${report.metrics.point_count} |`,
      `| Активных точек | ${report.metrics.active_count} |`,
      `| Городов без ПВЗ | ${report.metrics.city_count} |`,
      `| Исключено type=unknown | ${report.metrics.unknown_excluded} |`,
      `| Исключено неподдерживаемых кодов | ${report.metrics.unsupported_codes_excluded} |`,
      `| Пропущено строк с ошибками | ${report.metrics.skipped_row_count} |`,
      `| Ошибок в пропущенных строках | ${report.metrics.row_error_count} |`,
      `| Предупреждений | ${report.metrics.warning_count} |`,
      `| Данные изменились | ${report.metrics.changed ? 'да' : 'нет'} |`,
      '',
    );
  }

  if (report.reason) {
    lines.push('## Причина ошибки', '', `> ${cleanText(report.reason)}`, '');
  }
  if (report.skipped_row_examples?.length) {
    lines.push('## Пропущенные строки', '');
    report.skipped_row_examples.forEach(message => lines.push(`- ${cleanText(message)}`));
    lines.push('');
  }
  if (report.warning_examples?.length) {
    lines.push('## Предупреждения', '');
    report.warning_examples.forEach(message => lines.push(`- ${cleanText(message)}`));
    lines.push('');
  }

  lines.push('Подробный машинный отчет доступен в артефакте `pvz-update-report`.');
  return `${lines.join('\n')}\n`;
}

async function writeDiagnostics(report) {
  report.finished_at = new Date().toISOString();
  const reportPath = cleanText(process.env.PVZ_REPORT_PATH);
  if (reportPath) {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, buildMarkdownSummary(report), 'utf8');
  }
}

async function setOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, 'utf8');
}

async function main() {
  const report = {
    started_at: new Date().toISOString(),
    status: 'running',
    stage: 'Инициализация',
  };

  try {
    report.stage = 'Проверка конфигурации';
    const spreadsheetId = cleanText(process.env.GOOGLE_SPREADSHEET_ID);
    const accessToken = cleanText(process.env.GOOGLE_ACCESS_TOKEN);
    if (!spreadsheetId) throw new Error('Не задана переменная GOOGLE_SPREADSHEET_ID.');
    if (!accessToken) throw new Error('Не получен короткоживущий токен Google.');

    report.stage = 'Чтение Google Таблицы';
    const [pointRows, cityRows] = await fetchSheetRanges(spreadsheetId, accessToken);

    report.stage = 'Проверка данных';
    const cityResult = readCities(cityRows);
    const pointResult = readPoints(pointRows, cityResult.cityKeys);
    const warningExamples = [...cityResult.warnings, ...pointResult.warnings].slice(0, 20);
    report.warning_examples = warningExamples;
    report.skipped_row_examples = pointResult.errors.slice(0, 20);

    report.stage = 'Сравнение с текущим JSON';
    let currentPayload = null;
    try {
      currentPayload = JSON.parse(await readFile(CONFIG.outputPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const nextPayload = {
      schema_version: 1,
      updated_at: new Date().toISOString(),
      cities_without_pvz: cityResult.cities,
      points: pointResult.points,
    };
    assertSafeChange(currentPayload, nextPayload);

    const changed = JSON.stringify(comparablePayload(currentPayload || {})) !== JSON.stringify(comparablePayload(nextPayload));
    const activeCount = nextPayload.points.filter(point => point.is_active).length;
    report.metrics = {
      point_count: nextPayload.points.length,
      active_count: activeCount,
      city_count: nextPayload.cities_without_pvz.length,
      unknown_excluded: pointResult.unknownPointCount,
      unsupported_codes_excluded: pointResult.unsupportedCodeCount,
      skipped_row_count: pointResult.skippedRowCount,
      row_error_count: pointResult.errors.length,
      warning_count: cityResult.warnings.length + pointResult.warnings.length,
      changed,
    };

    await setOutput('changed', String(changed));
    await setOutput('point_count', String(nextPayload.points.length));
    await setOutput('active_count', String(activeCount));

    if (changed) {
      report.stage = 'Запись pvz.json';
      await writeFile(CONFIG.outputPath, `${JSON.stringify(nextPayload, null, 2)}\n`, 'utf8');
    }

    report.status = 'success';
    report.stage = changed ? 'JSON сформирован' : 'Изменений нет';
    await writeDiagnostics(report);
    console.log(JSON.stringify(report.metrics));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.status = 'failure';
    report.reason = message;
    try {
      await writeDiagnostics(report);
    } catch (diagnosticError) {
      console.error(`Не удалось сохранить диагностический отчет: ${diagnosticError}`);
    }
    console.error(`::error title=Обновление ПВЗ не выполнено::${escapeWorkflowCommand(message)}`);
    throw error;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
