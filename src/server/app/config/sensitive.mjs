export default {
  application: {
    development: {
      salt: 'eyJzZWNyZXRLZXkiOiI3RTVTRmE4d3d0My1fZnJpUkVLWHluUDQ5U1p5OWJBTHo5TVRLQXRhNldRPSIsIml2IjoiUjJXd1QtRU5qaUw5Qmg2RkRscTNEUT09In0=',
      aws:  {
        s3: {
          accessKeyID:      'yourAccessKeyID',
          secretAccessKey:  'yourSecretKey',
        },
      },
      mailer: {
        domain: 'mail.smtp.com',
        apiKey: 'youMailerAPIKey',
      },
    },
  },
};
