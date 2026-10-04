# One Always Free Ampere A1 VM in a public subnet, with a reserved public IP.
# The VM runs the whole stack in docker compose (infra/compose.yml).

terraform {
  required_version = ">= 1.6"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = ">= 6.0"
    }
  }
}

provider "oci" {
  region              = var.region
  config_file_profile = var.oci_profile
}

locals {
  compartment_id = coalesce(var.compartment_ocid, var.tenancy_ocid)
  # These ranges must match infra/compose.yml (media --udp-port-*, coturn --min-port/--max-port).
  tcp_ports = [80, 443, 3478]
  udp_ranges = {
    turn         = { min = 3478, max = 3478 }
    turn_relay   = { min = 49160, max = 49200 }
    media_webrtc = { min = 50000, max = 50100 }
  }
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    tcp_ports = join(",", local.tcp_ports)
    udp_ports = join(",", [for r in values(local.udp_ranges) : r.min == r.max ? tostring(r.min) : "${r.min}:${r.max}"])
  })
}

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu" {
  compartment_id           = local.compartment_id
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_vcn" "main" {
  compartment_id = local.compartment_id
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "hachiman"
  dns_label      = "hachiman"
}

resource "oci_core_internet_gateway" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "hachiman"
  enabled        = true
}

resource "oci_core_route_table" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "hachiman"
  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.main.id
  }
}

resource "oci_core_security_list" "main" {
  compartment_id = local.compartment_id
  vcn_id         = oci_core_vcn.main.id
  display_name   = "hachiman"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    source   = var.ssh_source_cidr
    protocol = "6"
    tcp_options {
      min = 22
      max = 22
    }
  }

  dynamic "ingress_security_rules" {
    for_each = local.tcp_ports
    content {
      source   = "0.0.0.0/0"
      protocol = "6"
      tcp_options {
        min = ingress_security_rules.value
        max = ingress_security_rules.value
      }
    }
  }

  dynamic "ingress_security_rules" {
    for_each = local.udp_ranges
    content {
      source   = "0.0.0.0/0"
      protocol = "17"
      udp_options {
        min = ingress_security_rules.value.min
        max = ingress_security_rules.value.max
      }
    }
  }

  # Path MTU discovery.
  ingress_security_rules {
    source   = "0.0.0.0/0"
    protocol = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }
}

resource "oci_core_subnet" "public" {
  compartment_id    = local.compartment_id
  vcn_id            = oci_core_vcn.main.id
  cidr_block        = "10.0.0.0/24"
  display_name      = "hachiman-public"
  dns_label         = "public"
  route_table_id    = oci_core_route_table.main.id
  security_list_ids = [oci_core_security_list.main.id]
}

resource "oci_core_instance" "main" {
  compartment_id      = local.compartment_id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = "hachiman"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = false # the reserved IP below is attached instead
    hostname_label   = "hachiman"
  }

  metadata = {
    ssh_authorized_keys = file(pathexpand(var.ssh_public_key_path))
    user_data           = base64encode(local.cloud_init)
  }

  # A newer Ubuntu image or an edited cloud-init must not replace the VM and its data.
  lifecycle {
    ignore_changes = [source_details[0].source_id, metadata]
  }
}

data "oci_core_vnic_attachments" "main" {
  compartment_id = local.compartment_id
  instance_id    = oci_core_instance.main.id
}

data "oci_core_private_ips" "main" {
  vnic_id = data.oci_core_vnic_attachments.main.vnic_attachments[0].vnic_id
}

# Reserved: the address survives a VM replacement, so the DNS records stay valid.
resource "oci_core_public_ip" "main" {
  compartment_id = local.compartment_id
  display_name   = "hachiman"
  lifetime       = "RESERVED"
  private_ip_id  = data.oci_core_private_ips.main.private_ips[0].id
}
