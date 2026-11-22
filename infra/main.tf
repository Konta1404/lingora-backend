# Firebase setup for Lingora (project lingora-e6b1f) — Firestore, rules, iOS app, backend service account.
#
#   brew install hashicorp/tap/terraform google-cloud-sdk
#   gcloud auth application-default login          # Terraform uses these credentials
#   cd infra && terraform init && terraform apply
#
# Sign-in providers (Email, Google, Apple) are NOT managed here: enabling them in
# Firebase console → Authentication → Sign-in method takes three clicks, keeps the free Spark plan,
# and lets Firebase create the Google OAuth client for you. (Terraform can only do it by upgrading
# to Identity Platform, which needs a billing account.)

terraform {
  required_providers {
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }
}

variable "project_id" {
  default = "lingora-e6b1f"
}

variable "firestore_location" {
  # Frankfurt, next to the Render service (render.yaml uses region: frankfurt). Can't be changed later.
  default = "europe-west3"
}

provider "google-beta" {
  project               = var.project_id
  user_project_override = true
  billing_project       = var.project_id
}

# APIs the setup needs.
resource "google_project_service" "apis" {
  provider = google-beta
  for_each = toset([
    "firestore.googleapis.com",
    "firebaserules.googleapis.com",
    "identitytoolkit.googleapis.com",
    "iam.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

# Firestore database.
resource "google_firestore_database" "default" {
  provider    = google-beta
  name        = "(default)"
  location_id = var.firestore_location
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.apis]
}

# Security rules from ../firestore.rules (users only see their own data; tokens are server-only).
resource "google_firebaserules_ruleset" "firestore" {
  provider = google-beta
  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/../firestore.rules")
    }
  }
  depends_on = [google_firestore_database.default]
}

resource "google_firebaserules_release" "firestore" {
  provider     = google-beta
  name         = "cloud.firestore"
  ruleset_name = google_firebaserules_ruleset.firestore.name
}

# iOS app + its GoogleService-Info.plist.
resource "google_firebase_apple_app" "ios" {
  provider     = google-beta
  display_name = "Lingora iOS"
  bundle_id    = "com.veselin.lingora"
}

data "google_firebase_apple_app_config" "ios" {
  provider = google-beta
  app_id   = google_firebase_apple_app.ios.app_id
}

# Service account the Render backend uses (Firestore + Firebase Auth admin).
resource "google_service_account" "backend" {
  provider     = google-beta
  account_id   = "lingora-backend"
  display_name = "Lingora backend (Render)"
  depends_on   = [google_project_service.apis]
}

resource "google_project_iam_member" "backend_roles" {
  provider = google-beta
  for_each = toset(["roles/datastore.user", "roles/firebaseauth.admin"])
  project  = var.project_id
  role     = each.key
  member   = "serviceAccount:${google_service_account.backend.email}"
}

resource "google_service_account_key" "backend" {
  provider           = google-beta
  service_account_id = google_service_account.backend.name
}

output "service_account_key_json" {
  description = "Paste into Render as FIREBASE_SERVICE_ACCOUNT (base64-encoded here)."
  value       = google_service_account_key.backend.private_key
  sensitive   = true
}

output "google_service_info_plist" {
  value     = data.google_firebase_apple_app_config.ios.config_file_contents
  sensitive = true
}
