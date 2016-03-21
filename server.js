var express = require('express');
var http = require('http');
var favicon = require('serve-favicon');
var path = require('path');
var morgan = require('morgan');
var winston = require('winston');
var bodyParser = require('body-parser');
var redis = require('redis');
var util = require('util');

var routes = require('./routes/home');

var nconf = require('nconf');
// read in keys and secrets.  You can store these in a variety of ways.  I like to use a keys.json 
// file that is in the .gitignore file, but you can also store them in the env
nconf.argv().env().file('keys.json');

var UNIVERSE = "universe";

// set up a single instance of a winston logger
var logger = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)()
    ]
});
logger.info(`Started wazstagram running on ${process.title} ${process.version}`);

/**
 *
 * @returns Redis client for node.js. Server is defined as (port=6379, host=got from config file).
 */
function createRedisClient() {
    return redis.createClient(
        6379,
        nconf.get('redisHost'), 
        {
            auth_pass: nconf.get('redisKey'), 
            return_buffers: true
        }
    ).on("error", function (err) {
        logger.error("ERR:REDIS: " + err);
    });    
}

/**
 * Create redis clients for the publisher and the subscriber.
 * The working model is:
 *          Instagram POST -> Redis Publisher (cache + publish events to topic) -> Redis Subscriber (public event to socket.io client)
 *
 * When client join the first time, Cache of Redis Publisher is read and sent to client.
 */
var redisSubClient = createRedisClient();
var redisPubClient = createRedisClient();

// configure the web server
var app = express();

// view engine setup
app.set('port', process.env.PORT || 3000);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(morgan('dev'));
app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

app.use(function(req, res, next) {

    //Assign local variable for each request-response.
    res.locals.nconf = nconf;
    res.locals.logger = logger;
    res.locals.publishFunc = publishImage;  //will be called when Instagram send a POST message.
    next();
});
app.use('/', routes)

// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    logger.error(err.message);
    res.end();
});

// start socket.io server
var server = http.createServer(app);
var io = require('socket.io').listen(server);
server.listen(app.get('port'), function(){
  logger.info('Express server listening on port ' + app.get('port'));
});


io.sockets.on('connection', function (socket) {
    socket.on('setCity', function (data) {
        logger.info('new connection: ' + data.city);

        /**
         * Initially send 100 pictures to client.
         */
        redisPubClient.lrange(data.city, 0, 100, function(err, picCache) {
            if (err) {
                logger.error(err);
                return;
            }
            logger.info("cache length: " + picCache.length);
            for (var i = picCache.length-1; i >= 0; i--) {

                //Send a single picture to client.
                socket.emit('newPic', picCache[i].toString());
            }

            /**
             * Join a room to receive pictures in real-time.
             */
            socket.join(data.city);
        });
    });
});

/**
 * Listen to new images from redis pub/sub
 */
redisSubClient.on('message', function(channel, message) {
    logger.verbose('channel: ' + channel + " ; message: " + message);
    var m = JSON.parse(message.toString());
    io.sockets.in (m.city).emit('newPic', m.pic);
    io.sockets.in (UNIVERSE).emit('newPic', m.pic);
}).subscribe('pics');

// send an event to redis letting all clients know there
// is a new image available
function publishImage(message) {
    logger.verbose('new pic published from: ' + message.city);
    logger.verbose(message.pic);
    redisPubClient.publish('pics', JSON.stringify(message));

    // cache results to ensure users get an initial blast of (n) images per city
    redisPubClient.lpush(message.city, message.pic);
    redisPubClient.ltrim(message.city, 0, 100);
    redisPubClient.lpush(UNIVERSE, message.pic);
    redisPubClient.ltrim(UNIVERSE, 0, 100);
}

module.exports = app;
