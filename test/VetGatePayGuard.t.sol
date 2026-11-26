// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {VetGatePayGuard} from "../contracts/VetGatePayGuard.sol";
import {MockERC20} from "../contracts/mocks/MockERC20.sol";

contract VetGatePayGuardTest is Test {
    VetGatePayGuard guard;
    MockERC20 token;

    uint256 oraclePk = 0xA11CE;
    address oracle;
    address buyer;
    address payTo;

    bytes32 constant PERMIT_TYPEHASH = keccak256(
        "VetGatePermit(address buyer,address payTo,address token,uint256 maxAmount,uint256 expiresAt,bytes32 nonce,uint8 verdict)"
    );

    function setUp() public {
        oracle = vm.addr(oraclePk);
        buyer = makeAddr("buyer");
        payTo = makeAddr("payTo");

        guard = new VetGatePayGuard(oracle);
        token = new MockERC20();
        token.mint(buyer, 1_000_000);
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("VetGatePayGuard")),
                keccak256(bytes("1")),
                block.chainid,
                address(guard)
            )
        );
    }

    function _signPermit(
        address _buyer,
        address _payTo,
        address _token,
        uint256 maxAmount,
        uint256 expiresAt,
        bytes32 nonce,
        uint8 verdict
    ) internal view returns (bytes memory sig) {
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, _buyer, _payTo, _token, maxAmount, expiresAt, nonce, verdict)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(oraclePk, digest);
        sig = abi.encodePacked(r, s, v);
    }

    function test_happyPath_emitsGuardedPaymentAndAttribution() public {
        uint256 amount = 100_000;
        uint256 maxAmount = 500_000;
        uint256 expiresAt = block.timestamp + 60;
        bytes32 nonce = keccak256("nonce-1");
        bytes memory sig = _signPermit(buyer, payTo, address(token), maxAmount, expiresAt, nonce, 1);
        bytes memory tag = hex"deadbeef";

        vm.prank(buyer);
        token.approve(address(guard), amount);

        vm.expectEmit(true, true, true, true);
        emit VetGatePayGuard.GuardedPayment(buyer, payTo, address(token), amount, nonce);
        vm.expectEmit(false, false, false, true);
        emit VetGatePayGuard.Attribution(tag);

        vm.prank(buyer);
        guard.payWithPermit(payTo, address(token), amount, maxAmount, expiresAt, nonce, 1, sig, tag);

        assertEq(token.balanceOf(payTo), amount);
        assertTrue(guard.usedNonces(nonce));
    }

    function test_revert_expiredPermit() public {
        uint256 expiresAt = block.timestamp - 1;
        bytes32 nonce = keccak256("expired");
        bytes memory sig = _signPermit(buyer, payTo, address(token), 1, expiresAt, nonce, 1);

        vm.prank(buyer);
        vm.expectRevert(VetGatePayGuard.ExpiredPermit.selector);
        guard.payWithPermit(payTo, address(token), 1, 1, expiresAt, nonce, 1, sig, "");
    }

    function test_revert_verdictNotAllow() public {
        bytes32 nonce = keccak256("block");
        bytes memory sig = _signPermit(buyer, payTo, address(token), 1, block.timestamp + 60, nonce, 0);

        vm.prank(buyer);
        vm.expectRevert(VetGatePayGuard.VerdictNotAllow.selector);
        guard.payWithPermit(payTo, address(token), 1, 1, block.timestamp + 60, nonce, 0, sig, "");
    }

    function test_revert_nonceReplayed() public {
        uint256 maxAmount = 1;
        uint256 expiresAt = block.timestamp + 60;
        bytes32 nonce = keccak256("replay");
        bytes memory sig = _signPermit(buyer, payTo, address(token), maxAmount, expiresAt, nonce, 1);

        vm.startPrank(buyer);
        token.approve(address(guard), 2);
        guard.payWithPermit(payTo, address(token), 1, maxAmount, expiresAt, nonce, 1, sig, "");
        vm.expectRevert(VetGatePayGuard.NonceAlreadyUsed.selector);
        guard.payWithPermit(payTo, address(token), 1, maxAmount, expiresAt, nonce, 1, sig, "");
        vm.stopPrank();
    }

    function test_revert_amountExceedsPermit_zero() public {
        bytes32 nonce = keccak256("zero");
        bytes memory sig = _signPermit(buyer, payTo, address(token), 100, block.timestamp + 60, nonce, 1);

        vm.prank(buyer);
        vm.expectRevert(VetGatePayGuard.AmountExceedsPermit.selector);
        guard.payWithPermit(payTo, address(token), 0, 100, block.timestamp + 60, nonce, 1, sig, "");
    }

    function test_revert_amountExceedsPermit_overMax() public {
        bytes32 nonce = keccak256("over");
        bytes memory sig = _signPermit(buyer, payTo, address(token), 100, block.timestamp + 60, nonce, 1);

        vm.prank(buyer);
        vm.expectRevert(VetGatePayGuard.AmountExceedsPermit.selector);
        guard.payWithPermit(payTo, address(token), 101, 100, block.timestamp + 60, nonce, 1, sig, "");
    }

    function test_revert_invalidSignature() public {
        uint256 wrongPk = 0xBEEF;
        bytes32 nonce = keccak256("bad-sig");
        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, buyer, payTo, address(token), 1, block.timestamp + 60, nonce, uint8(1))
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(buyer);
        vm.expectRevert(VetGatePayGuard.InvalidSignature.selector);
        guard.payWithPermit(payTo, address(token), 1, 1, block.timestamp + 60, nonce, 1, sig, "");
    }

    function test_revert_transferFailed() public {
        bytes32 nonce = keccak256("xfer");
        bytes memory sig = _signPermit(buyer, payTo, address(token), 1, block.timestamp + 60, nonce, 1);

        vm.prank(buyer);
        vm.expectRevert(VetGatePayGuard.TransferFailed.selector);
        guard.payWithPermit(payTo, address(token), 1, 1, block.timestamp + 60, nonce, 1, sig, "");
    }

    function test_revert_unauthorizedSetOracle() public {
        vm.prank(makeAddr("rando"));
        vm.expectRevert(VetGatePayGuard.Unauthorized.selector);
        guard.setOracleSigner(makeAddr("new"));
    }
}
