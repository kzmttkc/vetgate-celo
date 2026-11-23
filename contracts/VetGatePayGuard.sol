// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title VetGatePayGuard
 * @notice Altana session allowlist target on Celo Sepolia (11142220). Pays a seller in a
 *         stablecoin only with a valid EIP-712 VetGatePermit (verdict ALLOW) from the oracle.
 *         Emits Attribution(bytes) as ERC-8021 fallback when the relay strips calldata suffixes.
 */
contract VetGatePayGuard {
    bytes32 public constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant PERMIT_TYPEHASH =
        keccak256("VetGatePermit(address buyer,address payTo,address token,uint256 maxAmount,uint256 expiresAt,bytes32 nonce,uint8 verdict)");

    uint8 public constant VERDICT_ALLOW = 1;

    bytes32 public immutable DOMAIN_SEPARATOR;
    address public oracleSigner;
    address public owner;

    mapping(bytes32 => bool) public usedNonces;

    event GuardedPayment(
        address indexed buyer,
        address indexed payTo,
        address indexed token,
        uint256 amount,
        bytes32 nonce
    );
    /// @notice ERC-8021 attribution fallback when tx calldata suffix is not preserved by a relay.
    event Attribution(bytes tag);
    event OracleSignerUpdated(address indexed previousSigner, address indexed newSigner);

    error ExpiredPermit();
    error VerdictNotAllow();
    error AmountExceedsPermit();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error TransferFailed();
    error Unauthorized();

    constructor(address _oracleSigner) {
        owner = msg.sender;
        oracleSigner = _oracleSigner;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("VetGatePayGuard")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function setOracleSigner(address _oracleSigner) external {
        if (msg.sender != owner) revert Unauthorized();
        emit OracleSignerUpdated(oracleSigner, _oracleSigner);
        oracleSigner = _oracleSigner;
    }

    function payWithPermit(
        address payTo,
        address token,
        uint256 amount,
        uint256 maxAmount,
        uint256 expiresAt,
        bytes32 nonce,
        uint8 verdict,
        bytes calldata signature,
        bytes calldata attributionTag
    ) external {
        _verifyPermit(payTo, token, maxAmount, expiresAt, nonce, verdict, signature, amount);
        usedNonces[nonce] = true;
        bool ok = IERC20(token).transferFrom(msg.sender, payTo, amount);
        if (!ok) revert TransferFailed();

        emit GuardedPayment(msg.sender, payTo, token, amount, nonce);
        if (attributionTag.length > 0) {
            emit Attribution(attributionTag);
        }
    }

    function _verifyPermit(
        address payTo,
        address token,
        uint256 maxAmount,
        uint256 expiresAt,
        bytes32 nonce,
        uint8 verdict,
        bytes calldata signature,
        uint256 amount
    ) internal view {
        if (block.timestamp > expiresAt) revert ExpiredPermit();
        if (verdict != VERDICT_ALLOW) revert VerdictNotAllow();
        if (amount == 0 || amount > maxAmount) revert AmountExceedsPermit();
        if (usedNonces[nonce]) revert NonceAlreadyUsed();

        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, msg.sender, payTo, token, maxAmount, expiresAt, nonce, verdict)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (_recover(digest, signature) != oracleSigner) revert InvalidSignature();
    }

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}