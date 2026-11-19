'use strict';
const { body } = require('express-validator');
const support = require('../services/supportService');
const { collect } = require('../middleware/validate');
const { flash } = require('../utils/flash');

exports.home = (req, res) => res.render('public/home', { title: 'Secure digital banking', layout: 'layouts/public' });
exports.about = (req, res) => res.render('public/about', { title: 'About Qorvexa', layout: 'layouts/public' });
exports.contact = (req, res) => res.render('public/contact', { title: 'Contact us', layout: 'layouts/public' });

exports.contactValidators = [
  body('name').trim().isLength({ min: 2, max: 120 }).withMessage('Enter your name.'),
  body('email').trim().isEmail().withMessage('Enter a valid email address.').isLength({ max: 254 }),
  body('subject').trim().isLength({ min: 3, max: 140 }).withMessage('Enter a subject (3-140 characters).'),
  body('category').optional().isIn(support.CATEGORIES).withMessage('Choose a valid topic.'),
  body('message').trim().isLength({ min: 10, max: 4000 }).withMessage('Your message should be 10-4000 characters.'),
  collect,
];

exports.submitContact = async (req, res) => {
  if (req.validationErrors.length) {
    return res.status(422).render('public/contact', { title: 'Contact us', errors: req.validationErrors, form: req.body, layout: 'layouts/public' });
  }
  const t = await support.create({ user: req.user || null, name: req.body.name, email: req.body.email, subject: req.body.subject, category: req.body.category, message: req.body.message, req });
  flash(req, 'success', `Thank you. Your message was received as ticket ${t.ticket_number}. Our support team will reply by email or in your support centre.`);
  res.redirect('/contact');
};
