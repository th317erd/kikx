import FileSystem   from 'node:fs';
import { Readable } from 'node:stream';
import Nife         from 'nife';

import {
  ModuleBase,
  MimeUtils,
} from 'mythix';

import {
  S3Client,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// Documentation: https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/clients/client-s3/index.html

// Mythix uses a "module" system to extend its functionality.
// "modules" can be thought of as plugins for mythix.
// Modules have a common pattern of "start", and "stop",
// to start and stop the module. Mythix calls these methods
// directly upon app start and shutdown.
//
// This module enables AWS functionality for the application.
// For example, an object can be uploaded to S3 simply by
// fetching the module from the application, and interacting
// with it: await application.getAWS().uploadToS3({ ... });

export class AWSModule extends ModuleBase {
  static getModuleName() {
    return 'AWSModule';
  }

  constructor(application) {
    super(application);

    // Inject methods into the application
    Object.defineProperties(application, {
      'getAWS': {
        writable:     true,
        enumberable:  false,
        configurable: true,
        value:        () => this,
      },
    });
  }

  getAWSConfig() {
    return this.awsConfig;
  }

  getS3ClientConfig() {
    let app     = this.getApplication();
    let config  = app.getConfigValue('application.{environment}.aws.s3', {});

    return {
      maxAttempts:  3,
      retryMode:    'standard',
      region:       config.region,
      credentials:  {
        accessKeyId:      config.accessKeyID,
        secretAccessKey:  config.secretAccessKey,
      },
    };
  }

  getS3BucketConfig() {
    let app     = this.getApplication();
    let config  = app.getConfigValue('application.{environment}.aws.s3', {});

    return {
      Bucket:       config.bucket,
      CacheControl: 'max-age=86400', // 24 hours
    };
  }

  async start() {
  }

  async stop() {
    // No need to shutdown
  }

  // Upload a file to S3
  // the return value will be the URL
  // to the uploaded resource.
  // By default this method will
  // upload with public read access.
  async uploadToS3(options) {
    if (Nife.isEmpty(options))
      throw new TypeError('AWSModule::uploadToS3: "options" is required.');

    let {
      folder,
      fileName,
      contentType,
      content,
    } = options;

    if (Nife.isEmpty(folder))
      throw new TypeError('AWSModule::uploadToS3: "options.folder" is required.');

    if (Nife.isEmpty(fileName))
      throw new TypeError('AWSModule::uploadToS3: "options.fileName" is required.');

    if (Nife.isNotEmpty(options.filePath) && !content) {
      content = FileSystem.readFileSync(options.filePath);
      contentType = MimeUtils.getMimeTypeFromFilename(options.filePath);
    }

    if (!content)
      throw new TypeError('AWSModule::uploadToS3: "options.content" is required.');

    if (Buffer.isBuffer(content)) {
      if (!content.length)
        throw new TypeError('AWSModule::uploadToS3: "options.content" must be a valid Buffer instance.');
    } else if (!(content instanceof Readable)) {
      throw new TypeError('AWSModule::uploadToS3: "options.content" must be a Buffer instance, or an instance of streams.Readable.');
    }

    if (Nife.isEmpty(contentType))
      throw new TypeError('AWSModule::uploadToS3: "options.contentType" is required.');

    let clientConfig  = this.getS3ClientConfig();
    let bucketConfig  = this.getS3BucketConfig();
    let uploadConfig  = Object.assign({}, bucketConfig, {
      ACL:            options.ACL || 'public-read',
      Key:            `${folder}/${fileName}`,
      Body:           content,
      ContentType:    contentType,
      ContentLength:  (Buffer.isBuffer(content)) ? content.length : undefined,
    });

    try {
      let client        = new S3Client(clientConfig);
      let command       = new PutObjectCommand(uploadConfig);

      let result = await client.send(command);
      if (result['$metadata'].httpStatusCode !== 200) {
        let error = new Error('S3 upload failed');
        error.response = result;
        throw error;
      }

      return `https://${uploadConfig.Bucket}.s3.${clientConfig.region}.amazonaws.com/${uploadConfig.Key}`;
    } catch (error) {
      this.getLogger().error('AWSModule::uploadToS3: ', error);
      throw error;
    }
  }
}
