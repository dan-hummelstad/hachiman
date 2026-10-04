output "public_ip" {
  description = "Point DNS A records for <domain> and app.<domain> at this address."
  value       = oci_core_public_ip.main.ip_address
}

output "ssh" {
  value = "ssh ubuntu@${oci_core_public_ip.main.ip_address}"
}
