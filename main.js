const Twit = require('twit');
const _ = require('lodash');
const rp = require('request-promise-native');
const fs = require('fs');
const fsx = require('fs-extra');
const path = require('path');
const child_process = require('child_process');
const request = require('request');

process.env.UV_THREADPOOL_SIZE = 128;

let isExiting = false;

(() => {
  const { error } = require('dotenv').config({ path: path.join(__dirname, '.env') });
  if (error) {
    throw error;
  }
})();

process.chdir(__dirname);

const IMAGE_DUMP_FOLDER = path.resolve(process.env.TWITTER_IMAGE_DUMP_FOLDER);
const IMAGE_FOCUS_FOLDER = path.resolve(process.env.TWITTER_IMAGE_FOCUS_FOLDER);
const IMAGE_LIKE_FOLDER = path.resolve(process.env.TWITTER_IMAGE_LIKE_FOLDER);
const IMAGE_POSTLIKE_FOLDER = path.resolve(process.env.TWITTER_IMAGE_POSTLIKE_FOLDER);

const getRandomIntInclusive = (min, max) => {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const pSpawn = (...spawnArgs) => {
  return new Promise((resolve) => {
    const ps = child_process.spawn(...spawnArgs);
    ps.on('close', resolve);
  });
};

const pUtimes = (path, atime, mtime) => {
  return new Promise((resolve) => {
    fs.utimes(path, atime, mtime, resolve);
  });
}

const pResolveRedirection = (url) => new Promise((resolve, reject) => {
  request({ url, followRedirect: false }, function (err, res, body) {
    if (err) {
      return reject(err);
    }
    resolve(res.headers.location);
  });
});

const logger = (...args) => {
  const date = new Date();

  console.log(`${date.toLocaleDateString()}|${date.toLocaleTimeString({ hour12: false })}`, '>', ...args);
};

const mediaCache = fs.readdirSync(IMAGE_DUMP_FOLDER).reduce((cache, fileName) => {
  cache[fileName] = true;
  return cache;
}, {});

logger(`mediaCache keys.length: ${Object.keys(mediaCache).length}`);

const checkMediaCache = async (fileName) => {
  if (mediaCache[fileName]) {
    // logger('In memory media cache hit');
    return true;
  }
  const isOnDisk = await fsx.pathExists(path.join(IMAGE_DUMP_FOLDER, fileName));
  if (isOnDisk) {
    mediaCache[fileName] = true;
    // logger('On disk media cache hit');
  }
  return isOnDisk;
};

const fastCheckMediaCacheSync = (fileName) => {
  return !!mediaCache[fileName];
}

const errorLogger = (...args) => {
  const date = new Date();
  const logString = [
    `${date.toLocaleDateString()}|${date.toLocaleTimeString({ hour12: false })}`, '>', ...args
  ].map(String).join(' ');

  console.error(logString);
  fsx.outputFile(path.join(__dirname, 'error.log'), logString + '\n', { flag: 'a' });
};

(async () => {

  const T = new Twit({
    consumer_key:         process.env.TWITTER_CONSUMER_KEY,
    consumer_secret:      process.env.TWITTER_CONSUMER_SECRET,
    access_token:         process.env.TWITTER_ACCESS_TOKEN,
    access_token_secret:  process.env.TWITTER_ACCESS_SECRET,
    timeout_ms:           60*1000,  // optional HTTP request timeout to apply to all requests.
    strictSSL:            true,     // optional - requires SSL certificates to be valid.
  });


  const followingUsers = [];
  let cursor = -1;
  while (cursor != 0) {
    logger('Reading friends/list');
    const data = (await T.get('friends/list', { screen_name: process.env.TWITTER_FROM, count: 200, cursor })).data;
    cursor = data.next_cursor;
    followingUsers.push(...data.users);
  }
  logger(`followingUsers.length: ${followingUsers.length}`);
  await fsx.outputJSON(path.join(__dirname, 'followingUsers.json'), followingUsers, { spaces: 2 });

  const toPhotoFileParams = (tweet, /* media */ {media_url_https, expanded_url, sizes, url}, index) => {
    const createdAtDate = new Date(_.get(tweet, 'retweeted_status.created_at') || _.get(tweet, 'created_at'));
    const tweetText = (
      _.get(tweet, 'retweeted_status.text') || _.get(tweet, 'text') || ''
    ).split('\n').join(' ');

    const [m, id, ext] = media_url_https.match(/\/media\/(.*)\.(.*)/);
    const transformedUrl = url.split('/').slice(2).join('_');
    const authorScreenName = expanded_url.split('/')[3];
    const height = _.get(sizes, 'large.h') || 0;
    const width = _.get(sizes, 'large.w') || 0;
    return {
      fileName: `${(createdAtDate/1000).toFixed(0)}.${authorScreenName}.${transformedUrl}.${index}.${width}x${height}.${id}.${ext}`,
      remote: `${media_url_https}:large`,
      createdAtDate,
      authorScreenName,
      tweetText,
      ext,
      expanded_url,
    }
  }

  const downloadWithFileParams = (/* fileParams */ { fileName, ext, remote, expanded_url, createdAtDate, authorScreenName, tweetText }) => {
    return new Promise(async (resolve) => {
      if (!await checkMediaCache(`${fileName}`)) {
        logger(`Downloading (${createdAtDate.toLocaleDateString()}): ${remote}`);
        rp.get(remote, { encoding: null }).then(async (file) => {
          const now = new Date();
          await fsx.outputFile(path.join(IMAGE_DUMP_FOLDER, fileName), file);
          if (ext === 'jpg') await pSpawn('exiftool', ['-overwrite_original', '-charset', 'exif=utf8', `-Artist=${authorScreenName}`, fileName]);
          await pUtimes(fileName, now, createdAtDate);
          if (new Date(now - (process.env.TWITTER_IMAGE_MARK_AS_NEW_IN_SECONDS * 1000)) < createdAtDate) {
            // duplicate to focus folder
            fsx.outputFile(path.join(IMAGE_FOCUS_FOLDER, fileName), file);
            logger('\n====TODAY\'s====\n', authorScreenName, ': ', tweetText, '\n', expanded_url, '\n====^^^^^^^====\n');
          }
          resolve();
        }).catch((err) => {
          errorLogger(`Error getting ${remote}`, err);
          resolve();
        });
      } else {
        resolve();
      }
    });
  };

  const downloadSchedule = [];
  const maxDownloadingInParallel = 64;
  let downloadWaitGroup = 0;
  const flushDownloadSchedule = () => {
    if (!downloadSchedule.length && isExiting) process.exit(0);
    if (!downloadSchedule.length) return;
    if (!(downloadWaitGroup < maxDownloadingInParallel)) return;
    const fn = downloadSchedule.shift();
    if (!fn) return;
    downloadWaitGroup += 1;
    fn().then(() => { downloadWaitGroup -= 1; });
  };

  setInterval(() => {
    for (let i = 0; i < 5; i++) {
      flushDownloadSchedule();
    }
  }, 5);

  setInterval(() => {
    logger(`downloadSchedule.length: ${downloadSchedule.length}, downloadWaitGroup/maxDownloadingInParallel: ${downloadWaitGroup}/${maxDownloadingInParallel}`);
  }, 1000);

  setInterval(() => {
    fs.readdirSync(IMAGE_LIKE_FOLDER).forEach(async (fileName) => {
      const [, authorScreenName, shortenedComponent] = fileName.match(/\.([^\.]+)\.t\.co_([^\.]+)\./) || [undefined, undefined, undefined];
      if (!authorScreenName || !shortenedComponent) return;

      await fsx.copy(
        path.join(IMAGE_LIKE_FOLDER, fileName),
        path.join(IMAGE_POSTLIKE_FOLDER, fileName),
        { preserveTimestamps: true },
      );
      await fsx.remove(path.join(IMAGE_LIKE_FOLDER, fileName));

      const shortUrl = `https://t.co/${shortenedComponent}`;
      const twitterUrl = await pResolveRedirection(shortUrl);
      const [, id_str] = twitterUrl.match(/\/status\/(\d+)/);

      logger(`favorites/create: ${id_str}`);
      T.post('favorites/create', {
        id: id_str,
        include_entities: false,
      }).catch(errorLogger.bind(null, 'favorites/create', `id=${id_str}`));

      logger(`friendships/create: ${authorScreenName}`);
      T.post('friendships/create', {
        screen_name: authorScreenName,
        follow: false,
      }).catch(errorLogger.bind(null, 'friendships/create', `screen_name=${authorScreenName}`));
    });
  }, 5000);

  const extractPhotoFromTweet = function (highPriority, tweet) {
    const medias = _.get(tweet, 'extended_entities.media') || _.get(tweet, 'entities.media');
    if (medias) {
      medias
        .filter(m => m.type === 'photo')
        .map(toPhotoFileParams.bind(null, tweet))
        .forEach((params) => {
          if (fastCheckMediaCacheSync(params.fileName)) return;
          if (highPriority) {
            logger('Dispatching high priority download');
            return downloadWithFileParams(params);
          }
          downloadSchedule.push(downloadWithFileParams.bind(null, params));
        });
    }
  };

  const stream = T.stream('statuses/filter', { follow: followingUsers.map(u => u.id_str) });
  logger('Start listening on stream...');

  stream.on('message', extractPhotoFromTweet.bind(null, true));

  let favoriteCrawlerCounter = getRandomIntInclusive(0, followingUsers.length - 1);
  const favoriteCrawlerInterval = Math.ceil(15 * 60 * 1000 / (75 - 1));
  const favoriteCrawlerTimer = setInterval(() => {
    const { screen_name } = followingUsers[favoriteCrawlerCounter];
    favoriteCrawlerCounter += 1;
    logger(`Crawling favorites/list of screen_name: ${screen_name}`)
    if (favoriteCrawlerCounter >= followingUsers.length) favoriteCrawlerCounter = 0;
    T.get('favorites/list', {
      screen_name,
      count: 200,
    }).then(({ data }) => {
      const tweets = data;
      tweets.forEach(extractPhotoFromTweet.bind(null, false));
    }).catch(errorLogger.bind(null, 'favorites/list', `screen_name=${screen_name}`));
  }, favoriteCrawlerInterval);

  let userTimelineCrawlerCounter = getRandomIntInclusive(0, followingUsers.length - 1);
  const userTimelineCrawlerInterval = Math.ceil(15 * 60 * 1000 / (900 - 1));
  const userTimelineCrawlerTimer = setInterval(() => {
    const { screen_name } = followingUsers[userTimelineCrawlerCounter];
    userTimelineCrawlerCounter += 1;
    logger(`Crawling statuses/user_timeline of screen_name: ${screen_name}`)
    if (userTimelineCrawlerCounter >= followingUsers.length) userTimelineCrawlerCounter = 0;
    T.get('statuses/user_timeline', {
      screen_name,
      count: 200,
    }).then(({ data }) => {
      const tweets = data;
      tweets.forEach(extractPhotoFromTweet.bind(null, false));
    }).catch(errorLogger.bind(null, 'statuses/user_timeline', `screen_name=${screen_name}`));
  }, userTimelineCrawlerInterval);

  const homeTimelineCrawlerInterval = Math.ceil(15 * 60 * 1000 / (15 - 1));
  const homeTimelineCrawlerTimer = setInterval(() => {
    logger(`Crawling statuses/home_timeline`);
    T.get('statuses/home_timeline', {
      count: 200,
    }).then(({ data }) => {
      const tweets = data;
      tweets.forEach(extractPhotoFromTweet.bind(null, false));
    }).catch(errorLogger);
  }, homeTimelineCrawlerInterval);

  if (process.platform === "win32") {
    var rl = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout
    });
  
    rl.on("SIGINT", function () {
      process.emit("SIGINT");
    });
  }

  process.on("SIGINT", function () {
    logger('Caught SIGINT, stop listerning');
    isExiting = true;
    clearInterval(favoriteCrawlerTimer);
    clearInterval(userTimelineCrawlerTimer);
    clearInterval(homeTimelineCrawlerTimer);
    stream.stop();
  });
})().catch(console.error);