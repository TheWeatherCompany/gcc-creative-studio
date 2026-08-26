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

    # Okta group -> application role. A user whose token carries no group in
    # this map is rejected with a 403; there is no default role.
    OKTA_GROUP_ROLE_MAP = "{\"Creative Studio PortalAdmins\": \"admin\", \"Creative Studio Users\": \"user\", \"Creative Studio Workflows\": \"workflows\"}"
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
}

frontend_secrets = [
  "FIREBASE_API_KEY",          # Your Firebase Web API Key
  "FIREBASE_AUTH_DOMAIN",      # Your Firebase Auth Domain (e.g., project-id.firebaseapp.com)
  "FIREBASE_PROJECT_ID",       # Your Firebase Project ID
  "FIREBASE_STORAGE_BUCKET",   # Your Firebase Storage Bucket (e.g., project-id.appspot.com)
  "FIREBASE_MESSAGING_SENDER_ID", # Your Firebase Cloud Messaging Sender ID
  "FIREBASE_APP_ID",           # Your Firebase Web App ID
  "FIREBASE_MEASUREMENT_ID",   # Your Google Analytics Measurement ID
  "OKTA_ISSUER",               # e.g. https://your-org.okta.com
  "OKTA_CLIENT_ID",            # The Creative Studio SPA client ID
]

backend_secrets = [
  "OKTA_CLIENT_ID",
]

# Mounted in the backend container at runtime. OKTA_ISSUER and OKTA_AUDIENCE
# are plain env vars above; OKTA_CLIENT_ID is only used for the optional `cid`
# cross-check on access tokens.
backend_runtime_secrets = {
  "OKTA_CLIENT_ID" = "OKTA_CLIENT_ID"
}

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
