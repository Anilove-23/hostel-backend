const formData = require('form-data');
const Mailgun = require('mailgun.js');
require('dotenv').config();

// Create a Mailgun client
const mailgun = new Mailgun(formData);
const mg = mailgun.client({
  username: 'api',
  key: process.env.NEXT_PUBLIC_MAILGUN,
  url: process.env.NEXT_PUBLIC_URL || 'https://api.mailgun.net'
});

const DOMAIN = process.env.NEXT_PUBLIC_SANDBOX;

module.exports = { mg, DOMAIN };
