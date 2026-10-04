variable "tenancy_ocid" {
  description = "Tenancy OCID (the tenancy line of ~/.oci/config)."
  type        = string
}

variable "compartment_ocid" {
  description = "Compartment for all resources. Empty = the root compartment (the tenancy)."
  type        = string
  default     = ""
}

variable "region" {
  description = "Your home region. Always Free resources exist only there: ap-sydney-1 or ap-melbourne-1."
  type        = string
  default     = "ap-sydney-1"
}

variable "oci_profile" {
  description = "Profile name in ~/.oci/config."
  type        = string
  default     = "DEFAULT"
}

variable "ssh_public_key_path" {
  type    = string
  default = "~/.ssh/id_ed25519.pub"
}

variable "ssh_source_cidr" {
  description = "Who can reach SSH. Set it to your own IP/32 if you have a fixed address."
  type        = string
  default     = "0.0.0.0/0"
}

variable "availability_domain_index" {
  description = "Sydney and Melbourne have one AD. Change it in a multi-AD region on an 'Out of host capacity' error."
  type        = number
  default     = 0
}

# The Always Free A1 allowance is 2 OCPU and 12 GB in total.
variable "ocpus" {
  type    = number
  default = 2
}

variable "memory_gb" {
  type    = number
  default = 12
}

# Always Free block storage is 200 GB in total, boot volumes included.
variable "boot_volume_gb" {
  type    = number
  default = 100
}
