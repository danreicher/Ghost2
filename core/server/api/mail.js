// # Mail API
// API for sending Mail

const Promise = require('bluebird'),
    moment = require('moment'),
    pipeline = require('../lib/promise/pipeline'),
    localUtils = require('./utils'),
    models = require('../models'),
    common = require('../lib/common'),
    mail = require('../services/mail'),
    notificationsAPI = require('./notifications'),
    settingsAPI = require('./settings'),
    configurationAPI = require('./configuration'),
    postsAPI = require('./posts'),
    docName = 'mail';

let mailer;

/**
 * Send mail helper
 */
function sendMail(object) {
    if (!(mailer instanceof mail.GhostMailer)) {
        mailer = new mail.GhostMailer();
    }

    return mailer.send(object.mail[0].message).catch((err) => {
        if (mailer.state.usingDirect) {
            notificationsAPI.add(
                {
                    notifications: [{
                        type: 'warn',
                        message: [
                            common.i18n.t('warnings.index.unableToSendEmail'),
                            common.i18n.t('common.seeLinkForInstructions', {link: 'https://docs.ghost.org/docs/mail-config'})
                        ].join(' ')
                    }]
                },
                {context: {internal: true}}
            );
        }

        return Promise.reject(err);
    });
}

/**
 * ## Mail API Methods
 *
 * **See:** [API Methods](constants.js.html#api%20methods)
 * @typedef Mail
 * @param mail
 */
const apiMail = {

    sendNewsletter: function (options) {
        var attrs = ['recipients'];
        var tasks, posts, config;
        var recipients = options.recipients;
        var allEmail = 'newsletter@email.doessnarktranslate.com';
        var adminEmail;
        function generateNewsletter(options) {
            common.logging.info('Sending newsletter to: ' + recipients);
            postsAPI.browse({
                limit: 3,
                columns: ['id', 'title', 'feature_image', 'published_at'],
                order: 'published_at DESC',
                staticPages: false
            }).then(function (postData) {
                posts = postData;
                return models.User.findOne({
                    id: 1
                });
            }).then(function (adminUser) {
                adminEmail = adminUser.get('email');
                return configurationAPI.read({});
            }).then(function (configData) {
                config = configData.configuration[0];
                posts.posts.forEach(function (item) {
                    item.url = config.blogUrl + item.slug;
                    item.published_at = moment(item.published_at).format('ddd, MMM Do YYYY');
                });
                var templateData = {
                    blog: {
                        title: config.blogTitle,
                        url: config.blogUrl,
                        unsubscribe: '%mailing_list_unsubscribe_url%',
                        post: posts.posts
                    },
                    newsletter: {
                        interval: 'Weekly',
                        date: moment().format('ddd, MMMM Do YYYY')
                    }
                };
                return templateData;
            }).then(function (templateData) {
                return mail.utils.generateContent({
                    data: templateData,
                    template: 'newsletter-dst'
                });
            }).then(function (generatedContent) {
                var payload = {
                    mail: [{
                        message: {
                            to: recipients.toLowerCase() == 'all' ? allEmail : adminEmail,
                            subject: config.blogTitle + ' Updates',
                            html: generatedContent.html,
                            text: generatedContent.text
                        }
                    }]
                };
                common.logging.info('email: ' + payload.mail[0].message.to);
                return payload;
            }).then(function (payload) {
                return sendMail(payload, options);
            });
        }
        /**
         * ### Send mail
         */
        tasks = [
            localUtils.validate(docName, {
                attrs: attrs
            }),
            generateNewsletter
        ];
        return pipeline(tasks);
    },
    sendContact: function (object, options) {
        var tasks, emailData;
        /* Get the blog name from settings */
        function settingsQuery(result) {
            return settingsAPI.read({
                key: 'title'
            }).then(function (response) {
                // populate our template data
                emailData = {
                    blogName: response.settings[0].value, // blog name
                    senderName: object.name, // the sender's name
                    senderEmail: object.contact, // sender's contact
                    message: object.text // sender message
                };
            });
        }
        /* Find the first / admin user */
        function modelQuery() {
            return models.User.findOne({
                id: 1
            });
        }
        /* Send an email to the blog administrator */
        function generateAdminEmail(result) {
            return mail.utils.generateContent({
                data: emailData,
                template: 'contact'
            }).then(function (content) {
                var payload = {
                    mail: [{
                        message: {
                            replyTo: object.contact,
                            to: result.get('email'),
                            subject: emailData.blogName + ' Contact',
                            html: content.html,
                            text: content.text
                        }
                    }]
                };
                return payload;
            });
        }
        /* Send a confirmation e-mail to the user */
        function generateUserConfirmationEmail(result) {
            return mail.utils.generateContent({
                data: emailData,
                template: 'contact-confirm'
            }).then(function (content) {
                var payload = {
                    mail: [{
                        message: {
                            to: object.contact,
                            subject: emailData.blogName + ' Contact Confirmation',
                            html: content.html,
                            text: content.text
                        }
                    }]
                };
                return payload;
            });
        }
        /**
         * ### Send mail
         */
        function send(payload) {
            return sendMail(payload, options);
        }
        tasks = [
            settingsQuery,
            modelQuery,
            generateAdminEmail,
            send,
            generateUserConfirmationEmail,
            send
        ];
        return pipeline(tasks);
    },

    /**
     * ### Send
     * Send an email
     *
     * @public
     * @param {Mail} object details of the email to send
     * @returns {Promise}
     */
    send: (object, options) => {
        let tasks;

        /**
         * ### Format Response
         * @returns {Mail} mail
         */

        function formatResponse(data) {
            delete object.mail[0].options;
            // Sendmail returns extra details we don't need and that don't convert to JSON
            delete object.mail[0].message.transport;
            object.mail[0].status = {
                message: data.message
            };

            return object;
        }

        /**
         * ### Send Mail
         */

        function send() {
            return sendMail(object, options);
        }

        tasks = [
            localUtils.handlePermissions(docName, 'send'),
            send,
            formatResponse
        ];

        return pipeline(tasks, options || {});
    },

    /**
     * ### SendTest
     * Send a test email
     *
     * @public
     * @param {Object} options required property 'to' which contains the recipient address
     * @returns {Promise}
     */
    sendTest: (options) => {
        let tasks;

        /**
         * ### Model Query
         */

        function modelQuery() {
            return models.User.findOne({id: options.context.user});
        }

        /**
         * ### Generate content
         */

        function generateContent(result) {
            return mail.utils.generateContent({template: 'test'}).then((content) => {
                const payload = {
                    mail: [{
                        message: {
                            to: result.get('email'),
                            subject: common.i18n.t('common.api.mail.testGhostEmail'),
                            html: content.html,
                            text: content.text
                        }
                    }]
                };

                return payload;
            });
        }

        /**
         * ### Send mail
         */

        function send(payload) {
            return sendMail(payload, options);
        }

        tasks = [
            modelQuery,
            generateContent,
            send
        ];

        return pipeline(tasks);
    }
};

module.exports = apiMail;
