const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER?.trim(),
        pass: process.env.EMAIL_PASS?.trim()
    }
});

async function sendActivationEmail(email, token) {
    const activationUrl = `${process.env.ACTIVATION_URL}/activate/${token}`;
    try {
        await transporter.sendMail({
            from: `"Tuinfeest Pascal" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: '🎶 Activeer je Tuinfeest Swipe account',
            html: `
                <div style="font-family:sans-serif; max-width:500px; padding:20px; border:1px solid #1DB954; border-radius:10px;">
                    <h2 style="color:#1DB954">🎉 Tijd voor muziek!</h2>
                    <p>Klik op de knop om je account te activeren en nummers te beoordelen.</p>
                    <div style="text-align:center; margin:30px;">
                        <a href="${activationUrl}" style="background:#1DB954; color:white; padding:15px 30px; text-decoration:none; border-radius:50px; font-weight:bold;">START SWIPEN</a>
                    </div>
                    <p><small>Deze link is eenmalig geldig. Werkt de knop niet? Plak dit in je browser: ${activationUrl}</small></p>
                </div>`
        });
        return true;
    } catch (error) {
        console.error('❌ Email error:', error);
        return false;
    }
}

module.exports = { sendActivationEmail };