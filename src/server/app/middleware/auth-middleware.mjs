import Nife               from 'nife';
import { HTTPErrors }     from 'mythix';
import { PermissionBase } from '../permissions/index.mjs';

const {
  HTTPBaseError,
  HTTPUnauthorizedError,
  HTTPForbiddenError,
  HTTPInternalServerError,
  HTTPBadRequestError,
} = HTTPErrors;

// This middleware ensures the user is authenticated.
// If the user is not authenticated then a 401 Unauthorized
// error will be thrown. This middleware also checks
// the users permissions against the specified OrganizationID
// (which is almost always required for all requests), and
// if the user is not a member of the Organization specified,
// then this will throw a 403 Forbidden error.
// It first checks the "Authorization" header to see if
// a proper "Token {token}" auth token was provided.
// If the Authorization header is empty, then it will
// fallback to checking the cookie, and authenticate
// from that.
// If everything checks out, then the "user"
// property will be set upon the "request" itself.

export async function authMiddleware(request, response, next) {
  const getOrganizationID = () => {
    // Try to pull from the header
    let organizationIDHeader = request.headers['x-organization-id'];
    if (!Nife.isEmpty(organizationIDHeader))
      return organizationIDHeader;

    // Try to pull from query params
    let organizationIDQueryParam = (request.query || {})['organizationID'];
    if (!Nife.isEmpty(organizationIDQueryParam))
      return organizationIDQueryParam;

    let organizationIDParam = Nife.get(request, 'params.organizationID');
    if (!Nife.isEmpty(organizationIDParam))
      return organizationIDParam;

    // Try to pull from body
    let body = request.body;
    if (body && !Nife.isEmpty(body.organizationID))
      return body.organizationID;
  };

  let application = request.mythixApplication;
  let authHeader  = request.headers['authorization'];
  let authToken;

  if (!Nife.isEmpty(authHeader)) {
    authHeader = ('' + authHeader).trim();

    authHeader.replace(/^Bearer ([0-9a-zA-Z+/=_.-]+)$/, (m, _authToken) => {
      authToken = _authToken;
    });
  } else {
    let cookieName = application.getAuthTokenCookieName();
    if (request.cookies)
      authToken = request.cookies[cookieName];
  }

  let { User } = application.getModels();
  let user;
  let scope;
  let claims;

  try {
    let result = await User.validateSessionToken(authToken);
    user = result.user;
    scope = result.scope;
    claims = result.claims;
    claims.scope = scope;
  } catch (error) {
    throw new HTTPUnauthorizedError();
  }

  try {
    let organizationID = getOrganizationID();
    if (Nife.isNotEmpty(organizationID))
      user.setCurrentOrganizationID(organizationID);

    // If the route doesn't require an OrganizationID,
    // then skip permission checking against the organization.
    if (scope !== 'system' && scope !== 'admin' && Nife.get(request, 'route.requiresOrgID') !== false) {
      if (Nife.isEmpty(organizationID))
        throw new HTTPBadRequestError(null, '"organizationID" is required');

      let permitted = await PermissionBase.permissible(application, user, 'view:Organization', organizationID);
      if (PermissionBase.isDenial(permitted)) {
        if (permitted instanceof Error)
          throw new HTTPForbiddenError(null, permitted.message);
        else
          throw new HTTPForbiddenError();
      }
    }

    // Assign the "user" to "request", so
    // it can be accessed in controllers
    request.user = user;
    request.currentSessionToken = authToken;
    request.authTokenClaims = claims;

    // Call next middleware
    next();
  } catch (error) {
    // Re-throw error if it is an HTTPError
    if (error instanceof HTTPBaseError)
      throw error;

    // Otherwise... oopsie!
    application.getLogger().error(error);
    throw new HTTPInternalServerError();
  }
}
