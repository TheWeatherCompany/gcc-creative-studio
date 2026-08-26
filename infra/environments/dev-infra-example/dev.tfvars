gcp_project_id = "YOUR_GCP_PROJECT_ID"
gcp_region     = "us-central1"
environment    = "development"

# --- Service Names ---
backend_service_name  = "cstudio-backend-dev"
frontend_service_name = "cstudio-frontend-dev" # This is the Cloud Run service name
firebase_site_id      = "YOUR_FIREBASE_SITE_ID" # (Optional) Custom Firebase Hosting Site ID, defaults to the gcp_project_id

# --- GitHub Repo Details ---
github_conn_name   = "gh-repo-owner-con"
github_repo_owner  = "RepoOwnerName"
github_repo_name   = "repo-owner-gcc-creative-studio"
github_branch_name = "develop"

# Note: backend_custom_audiences / frontend_custom_audiences were removed.
# Custom audiences only apply to IAM-authenticated Cloud Run invocations, and
# both services grant run.invoker to allUsers because Firebase Hosting proxies
# /api/** without attaching credentials. Authorization happens in the
# application, so they were dead config.

# --- Service-Specific Environment Variables ---
be_env_vars = {
  common = {
    LOG_LEVEL = "INFO"

    # Phase 1: the org authorization server, with the SPA client ID as the
    # audience, because Okta API Access Management is not active yet.
    # Phase 2 changes these two values to a custom authorization server
    # (e.g. "https://YOUR_OKTA_DOMAIN/oauth2/creative-studio" and
    # "api://creative-studio"). No code change is needed for that.
    OKTA_ISSUER   = "https://YOUR_OKTA_DOMAIN"
    OKTA_AUDIENCE = "YOUR_OKTA_SPA_CLIENT_ID"

    # Enables the optional `cid` cross-check in okta_verifier. Same value as
    # OKTA_AUDIENCE in phase 1; in phase 2 the audience becomes an API
    # identifier while this stays the SPA client ID, so they are kept separate.
    OKTA_CLIENT_ID = "YOUR_OKTA_SPA_CLIENT_ID"

    # Okta group -> application role. A user whose token carries no group in
    # this map is rejected with a 403; there is no default role.
    #
    # A value may be a single role or a list. Some roles gate only a narrow set
    # of routes, so a group whose members also need ordinary access must map to
    # several. Only list groups that should confer a role: any other group the
    # claim filter admits, such as an approvals group, is ignored.
    OKTA_GROUP_ROLE_MAP = "{\"<your user group>\": \"user\", \"<your admin group>\": \"admin\", \"<your workflow group>\": [\"user\", \"workflows\"]}"
  }
  development = {
    ENVIRONMENT = "development"
  }
  production = {
    ENVIRONMENT = "production"
  }
}

fe_build_substitutions = {
  _ANGULAR_BUILD_COMMAND = "build-dev"

  # Substituted into environment.prod.ts at build time. Not secrets: a PKCE
  # public client ships its client ID in the JS bundle and in the client_id of
  # every /authorize redirect. Kept here rather than in the application repo so
  # a fork can point at its own Okta tenant without editing any source.
  _OKTA_ISSUER    = "https://YOUR_OKTA_DOMAIN"
  _OKTA_CLIENT_ID = "YOUR_OKTA_SPA_CLIENT_ID"
}

frontend_secrets = [
  "FIREBASE_API_KEY",          # Your Firebase Web API Key
  "FIREBASE_AUTH_DOMAIN",      # Your Firebase Auth Domain (e.g., project-id.firebaseapp.com)
  "FIREBASE_PROJECT_ID",       # Your Firebase Project ID
  "FIREBASE_STORAGE_BUCKET",   # Your Firebase Storage Bucket (e.g., project-id.appspot.com)
  "FIREBASE_MESSAGING_SENDER_ID", # Your Firebase Cloud Messaging Sender ID
  "FIREBASE_APP_ID",           # Your Firebase Web App ID
  "FIREBASE_MEASUREMENT_ID",   # Your Google Analytics Measurement ID
]

# No backend build-time secrets. Every Okta value is public config and travels
# as a plain env var in be_env_vars above.
backend_secrets = []

# Mounted in the backend container at runtime. Empty because no Okta value is
# secret; the wiring stays in place for genuine secrets later.
backend_runtime_secrets = {}

apis_to_enable = [
  "serviceusage.googleapis.com",     # Required to enable other APIs
  "iam.googleapis.com",              # Required for IAM management
  "cloudbuild.googleapis.com",       # Required for Cloud Build
  "artifactregistry.googleapis.com", # Required for Artifact Registry
  "run.googleapis.com",              # Required for Cloud Run
  "cloudresourcemanager.googleapis.com",
  "compute.googleapis.com",
  "cloudfunctions.googleapis.com",
  "iamcredentials.googleapis.com",
  "aiplatform.googleapis.com",
  "firestore.googleapis.com",
  "texttospeech.googleapis.com",
  "workflows.googleapis.com",
]
