import { ControllerBase } from './controller-base.mjs';

export class HealthCheckController extends ControllerBase {
  async health() {
    let application = this.getApplication();
    let connection  = application.getConnection();

    await connection.query('SELECT 1+1');

    this.setStatusCode(200);
    return '';
  }
}
