require('dotenv').config()
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(process.env.BOT_TOKEN, {polling: true});
const schedule = require('node-schedule');
const Promise = require('bluebird');
Promise.config({
    cancellation: true
});
const mysql = require('mysql');
// const connection = mysql.createConnection({
//     host     : process.env.DB_HOST,
//     database : process.env.DB_NAME,
//     user     : process.env.DB_USER,
//     password : process.env.DB_PASSWORD
// });

var db_config = {
    host     : process.env.DB_HOST,
    database : process.env.DB_NAME,
    user     : process.env.DB_USER,
    password : process.env.DB_PASSWORD
};

var connection;

function handleDisconnect() {
    connection = mysql.createConnection(db_config); // Recreate the connection, since
                                                    // the old one cannot be reused.

    connection.connect(function(err) {              // The server is either down
        if(err) {                                     // or restarting (takes a while sometimes).
            console.log('error when connecting to db:', err);
            setTimeout(handleDisconnect, 2000); // We introduce a delay before attempting to reconnect,
        }                                     // to avoid a hot loop, and to allow our node script to
    });                                     // process asynchronous requests in the meantime.
                                            // If you're also serving http, display a 503 error.
    connection.on('error', function(err) {
        console.log('db error', err);
        if(err.code === 'PROTOCOL_CONNECTION_LOST') { // Connection to the MySQL server is usually
            handleDisconnect();                         // lost due to either server restart, or a
        } else {                                      // connnection idle timeout (the wait_timeout
            throw err;                                  // server variable configures this)
        }
    });
}

handleDisconnect();



bot.on('message', msg => {

    console.log( msg )

    if ( msg.chat.id.toString() !== process.env.TG_CHANNEL_ID && msg.chat.id.toString() !== process.env.TG_GROUP_ID ) {

        connection.query(`SELECT * FROM wp_users WHERE user_nicename = '${msg.text}'`, function (err, wpUsers) {
            if (err) {
                console.log(err);
            } else {

                if (!wpUsers.length) {
                    bot.sendMessage(msg.from.id, 'Ошибка, такой пользователь не найден, пожалуйста проверьте введенный текст и попробуйте снова, благодарю')
                } else {


                    // обогащаем данные пользователя на id и имя телеги пусть будет
                    connection.query(`UPDATE wp_users SET telegram_id = ${msg.from.id}, telegram_username='${msg.from.username}', telegram_name='${msg.from.first_name}' WHERE id = ${wpUsers[0].ID}`);

                    // Ищем куплен ли курс у пользователя
                    connection.query(`
                        SELECT
                            p.ID AS 'order_id',
                            p.post_date AS 'purchase_date',
                            MAX( CASE WHEN pm.meta_key = '_customer_user'       AND p.ID = pm.post_id THEN pm.meta_value END ) AS 'user_id',
                            ( select group_concat( order_item_name ) FROM wp_woocommerce_order_items where order_id = p.ID AND order_item_name LIKE '%Мастерская души%' ) AS 'Items Ordered',
                            ( select group_concat(order_item_id ) FROM wp_woocommerce_order_items where order_id = p.ID AND order_item_name LIKE '%Мастерская души%' ) AS 'item_id'
                        FROM  wp_posts AS p
                        JOIN  wp_postmeta AS pm ON p.ID = pm.post_id
                        JOIN  wp_woocommerce_order_items AS oi ON p.ID = oi.order_id
                        WHERE post_type = 'shop_order'
                        AND p.post_status IN ('wc-processing', 'wc-completed', 'wc-pending')
                        AND pm.meta_key = '_customer_user'
                        AND pm.meta_value = ${wpUsers[0].ID}
                        AND ( select group_concat(order_item_id) FROM wp_woocommerce_order_items where order_id = p.ID AND order_item_name LIKE '%Мастерская души%' )
                            GROUP BY p.ID
                        `,
                        function (err, userOrders) {
                            if (err) {
                                console.log(err);
                            } else {

                                if (!userOrders.length) {
                                    bot.sendMessage(msg.from.id, 'Для получения доступа приобретите курс на сайте <a href="angelmind.ru">AngelMind.ru</a>', {parse_mode: 'HTML'})
                                } else {

                                    // получили курсы и можем взять их дату покупки - order['purchase_date']
                                    // далее надо найти срок их жизни

                                    // находим последнюю покупку
                                    var lastOrder = userOrders[0];
                                    userOrders.forEach(function (order) {
                                        if (order['purchase_date'] > lastOrder['purchase_date']) {
                                            lastOrder = order
                                        }
                                    })

                                    connection.query(`
                                        SELECT meta_value 
                                        FROM wp_postmeta
                                        WHERE post_id IN (
                                            SELECT meta_value 
                                            FROM wp_woocommerce_order_itemmeta 
                                            WHERE order_item_id = ${lastOrder['item_id']} AND meta_key = '_course_id'
                                        ) AND meta_key = '_lp_duration'
                                        `, function (error, duration) {
                                            if (err) {
                                                console.log(err);
                                            } else {

                                                if (duration.length) {

                                                    // тут у нас есть дата
                                                    // парсим ее в дни
                                                    let durationSource = duration[0]['meta_value'];
                                                    let days = 1;

                                                    if (durationSource.indexOf('day') != -1 || durationSource.indexOf('days') != -1) {
                                                        days = +durationSource.split(' ')[0];
                                                    }

                                                    if (durationSource.indexOf('week') != -1 || durationSource.indexOf('weeks') != -1) {
                                                        days = +durationSource.split(' ')[0] * 7;
                                                    }

                                                    if (durationSource.indexOf('month') != -1 || durationSource.indexOf('months') != -1) {
                                                        days = +durationSource.split(' ')[0] * 31;
                                                    }

                                                    if (durationSource.indexOf('year') != -1 || durationSource.indexOf('years') != -1) {
                                                        days = +durationSource.split(' ')[0] * 365;
                                                    }


                                                    // тут нам надо собрать инфу для создания subscription записи
                                                    // user_id - wpUsers[0].ID
                                                    // tg_id - msg.from.id
                                                    // end_date - days
                                                    // tg_chat_id - msg.chat.id


                                                    // проверяем ли действителен ли еще курс
                                                    // берем дату покупки и добавляем к ней количество дней курса, потом сравниваем с текущей датой
                                                    let courseEndDate = lastOrder.purchase_date.setDate(lastOrder.purchase_date.getDate() + days);


                                                    if (Date.now() > courseEndDate) {
                                                        bot.sendMessage(msg.from.id, 'У вас нет активной подписки в Мастерскую души для доступа в чат и канал, приобретите курс на сайте <a href="angelmind.ru">Angelmind.ru</a>', {parse_mode: 'HTML'})
                                                    } else {

                                                        // проверить не добавлен ли он еще в чат
                                                        connection.query(`SELECT * FROM wp_active_user_courses WHERE user_id = ${ wpUsers[0].ID } AND tg_id = ${ msg.from.id } AND tg_chat_id = '${ process.env.TG_CHANNEL_ID }' AND end_date = '${courseEndDate}'`, function(err, res){
                                                            if ( err ) { console.log( err ) } else {
                                                                if ( !res.length ) {
                                                                    connection.query(`INSERT wp_active_user_courses SET user_id = '${ wpUsers[0].ID }', tg_id = ${ msg.from.id }, tg_chat_id = '${ process.env.TG_CHANNEL_ID }', end_date = '${courseEndDate}'`)
                                                                    bot.createChatInviteLink(process.env.TG_CHANNEL_ID)
                                                                        .then((linkObject) => {
                                                                            bot.sendMessage(
                                                                                msg.chat.id,
                                                                                `Держите ссылку на закрытый канал Мастерская души, добро пожаловать 🤗 <a href="${linkObject.invite_link}">Сюда жми</a>`,
                                                                                {parse_mode: 'HTML'}
                                                                            )
                                                                        })
                                                                } else {
                                                                    bot.createChatInviteLink(process.env.TG_CHANNEL_ID)
                                                                        .then((linkObject) => {
                                                                            bot.sendMessage(
                                                                                msg.chat.id,
                                                                                `У вас уже есть доступ в канал <a href="${linkObject.invite_link}">Перейти</a>`,
                                                                                {parse_mode: 'HTML'}
                                                                            )
                                                                        })
                                                                }
                                                            }
                                                        })


                                                        connection.query(`SELECT * FROM wp_active_user_courses WHERE user_id = ${ wpUsers[0].ID } AND tg_id = ${ msg.from.id } AND tg_chat_id = '${ process.env.TG_GROUP_ID }' AND end_date = '${courseEndDate}'`, function(err, res){
                                                            if ( err ) { console.log( err ) } else {
                                                                if ( !res.length ) {
                                                                    connection.query(`INSERT wp_active_user_courses SET user_id = '${ wpUsers[0].ID }', tg_id = ${ msg.from.id }, tg_chat_id = '${ process.env.TG_GROUP_ID }', end_date = '${courseEndDate}'`)
                                                                    bot.createChatInviteLink(process.env.TG_GROUP_ID)
                                                                        .then((linkObject) => {
                                                                            bot.sendMessage(
                                                                                msg.chat.id,
                                                                                'Приходите в наш прекрасный чат, не стесняйтесь задавать вопросы кураторам ❤️  <a href="' + linkObject.invite_link + '">Все пиздюки тут</a>',
                                                                                {parse_mode: 'HTML'}
                                                                            )
                                                                        })
                                                                } else {
                                                                    bot.createChatInviteLink(process.env.TG_GROUP_ID)
                                                                        .then((linkObject) => {
                                                                            bot.sendMessage(
                                                                                msg.chat.id,
                                                                                `У вас уже есть доступ в чат <a href="${linkObject.invite_link}">Перейти</a>`,
                                                                                {parse_mode: 'HTML'}
                                                                            )
                                                                        })
                                                                }
                                                            }
                                                        })
                                                    }
                                                }
                                            }
                                        }
                                    )
                                }
                            }
                        }
                    )
                }
            }
        })
    }
})











const job = schedule.scheduleJob('00 00 00 * * *', function(){

    connection.query(`SELECT * FROM wp_active_user_courses WHERE end_date > ${Date.now()}`, (err, res) => {
        console.log( res )

        res.forEach((user) => {

            console.log( +user.tg_chat_id, user.tg_id)

            bot.banChatMember(+user.tg_chat_id, user.tg_id )
                .then(kicked => {
                    if ( kicked ) {
                        bot.unbanChatMember(+user.tg_chat_id, user.tg_id )
                    }
                })
        })


        connection.query(`DELETE FROM wp_active_user_courses WHERE end_date < 1658259195000`)
    })
});




// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
