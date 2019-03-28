# live-twitter-images

Shitty script for crawling images on twitter.

This bot helps you download every images from the tweets in your home timeline and your following users' timeline, including all retweets and liked tweet.

## Usage

```bash
# Requires Node >= 8
git clone https://github.com/arthow4n/live-twitter-images
cd live-twitter-images
npm install

cp .env.sample .env
# Get your own tokens from https://developer.twitter.com and put them into .env
# Edit .env to your needs
# Don't forget to change `TWITTER_FROM`

npm start
```

Downloaded images will go to `TWITTER_IMAGE_DUMP_FOLDER`, and images posted within `TWITTER_IMAGE_MARK_AS_NEW_IN_SECONDS` will be also copied to `TWITTER_IMAGE_FOCUS_FOLDER`.
You can move any images from those folder to `TWITTER_IMAGE_LIKE_FOLDER`, the bot will then help you like the tweet and follow that user with your account, then move the image to `TWITTER_IMAGE_POSTLIKE_FOLDER`.
