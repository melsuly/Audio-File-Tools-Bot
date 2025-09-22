require('dotenv').config();

const { Telegraf } = require('telegraf');
const axios = require('axios');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

if (ffmpegPath) {
  ffmpeg.setFfmpegPath(ffmpegPath);
}

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN не задан. Добавьте его в .env файл или переменные окружения.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const tmpRoot = path.join(os.tmpdir(), 'audio-tools-bot');

class TimecodeParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimecodeParseError';
  }
}

async function ensureTmpDir() {
  await fsPromises.mkdir(tmpRoot, { recursive: true });
}

function buildTempPath(ext = '') {
  const suffix = ext.startsWith('.') ? ext : ext ? `.${ext}` : '';
  return path.join(tmpRoot, `${Date.now()}-${crypto.randomUUID()}${suffix}`);
}

async function downloadFile(url, destinationPath) {
  const response = await axios.get(url, { responseType: 'stream' });
  await pipeline(response.data, fs.createWriteStream(destinationPath));
}

async function convertToVoice(inputPath, outputPath, trimRange) {
  return new Promise((resolve, reject) => {
    let startTime;
    let duration;

    if (trimRange) {
      const { start, end } = trimRange;
      startTime = typeof start === 'number' ? start : undefined;

      if (typeof end === 'number') {
        const base = typeof start === 'number' ? start : 0;
        const calculatedDuration = end - base;

        if (calculatedDuration <= 0) {
          reject(new Error('Неверный интервал для обрезки аудио.'));
          return;
        }

        duration = calculatedDuration;
      }
    }

    const command = ffmpeg(inputPath);

    if (typeof startTime === 'number') {
      command.setStartTime(startTime);
    }

    if (typeof duration === 'number') {
      command.setDuration(duration);
    }

    command
      .outputOptions([
        '-acodec libopus',
        '-b:a 48k',
        '-ac 1',
        '-ar 48000',
        '-vn'
      ])
      .format('ogg')
      .on('end', resolve)
      .on('error', reject)
      .save(outputPath);
  });
}

function parseTimecodes(rawText) {
  if (!rawText) {
    return null;
  }

  const match = rawText.match(/\b(\d{1,4})\s*:\s*(\d{1,4})\b/);

  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new TimecodeParseError('Не удалось преобразовать таймкоды в числа.');
  }

  if (start < 0 || end <= start) {
    throw new TimecodeParseError('Конечное время должно быть больше начального.');
  }

  return { start, end };
}

async function processAudio(ctx, fileId, filenameHint, trimRange) {
  await ensureTmpDir();
  const inputExt = path.extname(filenameHint || '') || '.tmp';
  const inputPath = buildTempPath(inputExt);
  const outputPath = buildTempPath('.ogg');

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    await downloadFile(fileLink.href, inputPath);

    await ctx.sendChatAction('record_voice');
    await convertToVoice(inputPath, outputPath, trimRange);

    await ctx.replyWithVoice({ source: fs.createReadStream(outputPath) });
  } finally {
    await Promise.allSettled([
      fsPromises.unlink(inputPath).catch(() => {}),
      fsPromises.unlink(outputPath).catch(() => {})
    ]);
  }
}

function isAudioDocument(document) {
  if (!document) {
    return false;
  }

  if (document.mime_type && document.mime_type.startsWith('audio/')) {
    return true;
  }

  return Boolean(document.file_name && document.file_name.match(/\.(mp3|wav|m4a|flac|aac|ogg|oga)$/i));
}

function extractTimecodesFromMessage(message) {
  const raw = message.caption || message.text || '';
  try {
    return parseTimecodes(raw);
  } catch (error) {
    if (error instanceof TimecodeParseError) {
      throw error;
    }
    throw new Error(`Неожиданная ошибка при разборе таймкодов: ${error.message}`);
  }
}

bot.start((ctx) => ctx.reply('Отправь аудиофайл, и я верну готовое голосовое сообщение.'));

bot.on('audio', async (ctx) => {
  const audio = ctx.message.audio;
  let trimRange = null;

  try {
    trimRange = extractTimecodesFromMessage(ctx.message);
  } catch (error) {
    if (error instanceof TimecodeParseError) {
      await ctx.reply('Не удалось понять таймкоды. Используй формат "0:40", где числа — секунды начала и конца.');
      return;
    }

    console.error('Ошибка при разборе таймкодов (audio):', error);
    await ctx.reply('Произошла ошибка при разборе таймкодов. Попробуй позже.');
    return;
  }

  try {
    await processAudio(ctx, audio.file_id, audio.file_name || audio.file_unique_id, trimRange);
  } catch (error) {
    console.error('Ошибка при обработке audio сообщения:', error);
    await ctx.reply('Не получилось обработать файл. Попробуй ещё раз позже.');
  }
});

bot.on('document', async (ctx, next) => {
  if (!isAudioDocument(ctx.message.document)) {
    if (next) {
      return next();
    }
    return;
  }

  let trimRange = null;

  try {
    trimRange = extractTimecodesFromMessage(ctx.message);
  } catch (error) {
    if (error instanceof TimecodeParseError) {
      await ctx.reply('Не удалось понять таймкоды. Используй формат "0:40", где числа — секунды начала и конца.');
      return;
    }

    console.error('Ошибка при разборе таймкодов (document):', error);
    await ctx.reply('Произошла ошибка при разборе таймкодов. Попробуй позже.');
    return;
  }

  try {
    await processAudio(
      ctx,
      ctx.message.document.file_id,
      ctx.message.document.file_name || ctx.message.document.file_unique_id,
      trimRange
    );
  } catch (error) {
    console.error('Ошибка при обработке document сообщения:', error);
    await ctx.reply('Не получилось обработать файл. Попробуй ещё раз позже.');
  }
});

bot.catch((err, ctx) => {
  console.error('Global bot error:', err);
  if (ctx && typeof ctx.reply === 'function') {
    ctx.reply('Случилась ошибка. Попробуй повторить позже.');
  }
});

bot.launch().then(() => {
  console.log('Bot запущен и готов конвертировать аудио.');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
